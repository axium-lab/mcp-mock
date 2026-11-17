import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SERVER_INFO } from "../../../src/core/server-info.ts";
import { validateAgainst, validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// What the SDK never sends, and what a sessionless legacy server promises.
// Every JSON-RPC body the mock answers with must validate against the
// 2025-11-25 schema.
const REVISION = "2025-11-25";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: REVISION, capabilities: {}, clientInfo: { name: "tests", version: "0.0.0" } },
};

interface Reply {
  status: number;
  headers: Headers;
  // Arbitrary JSON: each test asserts the shape it expects.
  body: any;
}

describe("2025-11-25 over raw HTTP", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/${REVISION}/mcp`;
  });
  afterAll(() => stopServer(running.server));

  // `headers` overrides the defaults a conforming client sends after
  // initialize (undefined removes one).
  async function post(
    body: unknown,
    headers: Record<string, string | undefined> = {},
    raw?: string,
  ): Promise<Reply> {
    const merged: Record<string, string | undefined> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": REVISION,
      ...headers,
    };
    const sent = Object.fromEntries(
      Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const res = await fetch(url, { method: "POST", headers: sent, body: raw ?? JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  function expectValid(reply: Reply, definition?: string, value: unknown = reply.body): void {
    expect(validateMessage(REVISION, reply.body)).toEqual({ valid: true, errors: [] });
    if (definition) {
      expect(validateAgainst(REVISION, definition, value)).toEqual({ valid: true, errors: [] });
    }
  }

  const request = (method: string, params?: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 2,
    method,
    ...(params ? { params } : {}),
  });

  describe("lifecycle", () => {
    it("initializes without assigning a session", async () => {
      const reply = await post(INITIALIZE, { "mcp-protocol-version": undefined });
      expect(reply.status).toBe(200);
      expect(reply.body.result).toEqual({
        protocolVersion: REVISION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO,
      });
      expect(reply.headers.get("mcp-session-id")).toBeNull();
      expectValid(reply, "InitializeResult", reply.body.result);
    });

    it("answers an unsupported requested version with its own, not an error", async () => {
      const reply = await post({
        ...INITIALIZE,
        params: { ...INITIALIZE.params, protocolVersion: "1999-01-01" },
      });
      expect(reply.status).toBe(200);
      expect(reply.body.result.protocolVersion).toBe(REVISION);
    });

    it("rejects initialize params missing required fields, in-band", async () => {
      const reply = await post({ ...INITIALIZE, params: { protocolVersion: REVISION } });
      expect(reply.status).toBe(200);
      expect(reply.body.error.code).toBe(-32602);
      expectValid(reply);
    });

    it("accepts the initialized notification with 202", async () => {
      const reply = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      expect(reply.status).toBe(202);
      expect(reply.body).toBeUndefined();
    });

    it("accepts a posted response with 202", async () => {
      const reply = await post({ jsonrpc: "2.0", id: 9, result: {} });
      expect(reply.status).toBe(202);
    });

    it("answers ping with an empty result", async () => {
      const reply = await post(request("ping"));
      expect(reply.status).toBe(200);
      expect(reply.body.result).toEqual({});
      expectValid(reply);
    });

    it("serves requests without a prior initialize, having no session to tie them to", async () => {
      const reply = await post(request("tools/list"));
      expect(reply.status).toBe(200);
      expect(reply.body.result.tools).toHaveLength(22);
    });
  });

  describe("tools", () => {
    it("lists tools without the 2026-07-28 additions", async () => {
      const reply = await post(request("tools/list"));
      expect(Object.keys(reply.body.result)).toEqual(["tools"]);
      expectValid(reply, "ListToolsResult", reply.body.result);
    });

    it("calls echo with a plain result", async () => {
      const reply = await post(request("tools/call", { name: "echo", arguments: { text: "hi" } }));
      expect(reply.status).toBe(200);
      expect(reply.body.result).toEqual({ content: [{ type: "text", text: "Echo: hi" }] });
      expectValid(reply, "CallToolResult", reply.body.result);
    });

    it("reports bad arguments as a tool execution error", async () => {
      const reply = await post(request("tools/call", { name: "echo", arguments: {} }));
      expect(reply.status).toBe(200);
      expect(reply.body.result.isError).toBe(true);
      expectValid(reply);
    });

    it("answers an unknown tool in-band", async () => {
      const reply = await post(request("tools/call", { name: "nope", arguments: {} }));
      expect(reply.status).toBe(200);
      expect(reply.body.error).toEqual({ code: -32602, message: "Unknown tool: nope" });
      expectValid(reply);
    });

    it("answers an unknown method in-band with -32601", async () => {
      const reply = await post(request("completion/complete"));
      expect(reply.status).toBe(200);
      expect(reply.body.error.code).toBe(-32601);
      expectValid(reply);
    });
  });

  describe("protocol version header", () => {
    it("accepts a request without the header", async () => {
      const reply = await post(request("tools/list"), { "mcp-protocol-version": undefined });
      expect(reply.status).toBe(200);
    });

    it("refuses a header naming another version", async () => {
      const reply = await post(request("tools/list"), { "mcp-protocol-version": "2026-07-28" });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32000);
      expect(reply.body.error.message).toContain("supported versions: 2025-11-25");
      expectValid(reply);
    });

    it("does not check the header on initialize, which comes before negotiation", async () => {
      const reply = await post(INITIALIZE, { "mcp-protocol-version": "2026-07-28" });
      expect(reply.status).toBe(200);
    });

    it("fails a modern request without a modern error body, so dual-era clients fall back", async () => {
      const reply = await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
      );
      expect(reply.status).toBe(400);
      expect([-32020, -32021, -32022]).not.toContain(reply.body.error.code);
    });
  });

  describe("transport", () => {
    it.each(["GET", "DELETE"])("refuses %s with 405, offering no stream and no session", async (method) => {
      const res = await fetch(url, { method, headers: { accept: "text/event-stream" } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(validateMessage(REVISION, await res.json()).valid).toBe(true);
    });

    it("refuses batches, removed in 2025-06-18", async () => {
      const reply = await post([request("ping")]);
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32600);
      expectValid(reply);
    });

    it("answers malformed JSON with 400, -32700 and no id", async () => {
      const reply = await post(undefined, {}, "{not json");
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
      expectValid(reply);
    });

    it("refuses a client that does not accept both JSON and SSE", async () => {
      const reply = await post(request("ping"), { accept: "application/json" });
      expect(reply.status).toBe(406);
      expectValid(reply);
    });

    it("refuses a body that is not application/json", async () => {
      const reply = await post(request("ping"), { "content-type": "text/plain" });
      expect(reply.status).toBe(415);
      expectValid(reply);
    });
  });
});
