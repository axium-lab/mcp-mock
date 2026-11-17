import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SERVER_INFO } from "../../../src/core/server-info.ts";
import { validateAgainst, validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// What the SDK never sends: wrong headers, legacy traffic, malformed bodies.
// Every JSON-RPC body the mock answers with must still validate against the
// 2026-07-28 schema.
const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientInfo": { name: "tests", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function request(method: string, params: Record<string, unknown> = {}, id: number | string = 1) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: META } };
}

interface Reply {
  status: number;
  headers: Headers;
  // Arbitrary JSON: each test asserts the shape it expects.
  body: any;
}

describe("2026-07-28 over raw HTTP", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/${REVISION}/mcp`;
  });
  afterAll(() => stopServer(running.server));

  // Sends a body with the headers a conforming client derives from it;
  // `headers` overrides them (undefined removes one).
  async function post(
    body: unknown,
    headers: Record<string, string | undefined> = {},
    raw?: string,
  ): Promise<Reply> {
    const message = body as { method?: string; params?: { name?: unknown } };
    const derived: Record<string, string | undefined> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": REVISION,
      "mcp-method": message?.method,
      "mcp-name": typeof message?.params?.name === "string" ? message.params.name : undefined,
      ...headers,
    };
    const sent = Object.fromEntries(
      Object.entries(derived).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const res = await fetch(url, { method: "POST", headers: sent, body: raw ?? JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  function expectValid(reply: Reply, definition?: string): void {
    expect(validateMessage(REVISION, reply.body)).toEqual({ valid: true, errors: [] });
    if (definition) {
      expect(validateAgainst(REVISION, definition, reply.body)).toEqual({ valid: true, errors: [] });
    }
  }

  describe("methods", () => {
    it("answers server/discover with versions, capabilities and identity", async () => {
      const reply = await post(request("server/discover"));
      expect(reply.status).toBe(200);
      expect(reply.headers.get("content-type")).toContain("application/json");
      expect(reply.body.result).toEqual({
        supportedVersions: [REVISION],
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true, subscribe: true },
          prompts: { listChanged: true },
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
        ttlMs: 3_600_000,
        cacheScope: "public",
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      });
      expectValid(reply);
      expect(validateAgainst(REVISION, "DiscoverResult", reply.body.result).valid).toBe(true);
    });

    it("lists tools with cache hints, identically on every call", async () => {
      const first = await post(request("tools/list"));
      const second = await post(request("tools/list"));
      expect(first.status).toBe(200);
      expect(first.body.result.ttlMs).toBe(3_600_000);
      expect(first.body.result.cacheScope).toBe("public");
      expect(first.body.result.nextCursor).toBeUndefined();
      expect(second.body).toEqual(first.body);
      expectValid(first);
      expect(validateAgainst(REVISION, "ListToolsResult", first.body.result).valid).toBe(true);
    });

    it("rejects a cursor it never issued, in-band", async () => {
      const reply = await post(request("tools/list", { cursor: "made-up" }));
      expect(reply.status).toBe(200);
      expect(reply.body.error.code).toBe(-32602);
      expectValid(reply);
    });

    it("calls echo", async () => {
      const reply = await post(request("tools/call", { name: "echo", arguments: { text: "hi" } }));
      expect(reply.status).toBe(200);
      expect(reply.body.result.content).toEqual([{ type: "text", text: "Echo: hi" }]);
      expectValid(reply);
      expect(validateAgainst(REVISION, "CallToolResult", reply.body.result).valid).toBe(true);
    });

    it("reports bad arguments as a tool execution error", async () => {
      const reply = await post(
        request("tools/call", { name: "echo", arguments: { text: "hi", extra: true } }),
      );
      expect(reply.status).toBe(200);
      expect(reply.body.result.isError).toBe(true);
      expect(reply.body.result.content[0].text).toContain("unexpected argument(s): extra");
      expectValid(reply);
    });

    it.each([
      ["an unknown tool", { name: "nope", arguments: {} }, "Unknown tool: nope"],
      ["a missing name", { arguments: {} }, '"name" must be a string'],
      ["non-object arguments", { name: "echo", arguments: [1] }, '"arguments" must be an object'],
    ])("answers %s with an in-band invalid-params error", async (_case, params, message) => {
      const reply = await post(request("tools/call", params));
      expect(reply.status).toBe(200);
      expect(reply.body.error.code).toBe(-32602);
      expect(reply.body.error.message).toContain(message);
      expectValid(reply);
    });

    it("answers an unknown method with 404 and -32601", async () => {
      const reply = await post(request("completion/complete"));
      expect(reply.status).toBe(404);
      expect(reply.body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found: completion/complete" },
      });
      expectValid(reply);
    });

    it("acknowledges a notification with 202 and no body", async () => {
      const reply = await post({ jsonrpc: "2.0", method: "notifications/whatever" });
      expect(reply.status).toBe(202);
      expect(reply.body).toBeUndefined();
    });
  });

  describe("transport", () => {
    it.each(["GET", "DELETE", "PUT"])("refuses %s with 405 and Allow: POST", async (method) => {
      const res = await fetch(url, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32000);
      expect(validateMessage(REVISION, body).valid).toBe(true);
    });

    it("refuses a client that does not accept both JSON and SSE", async () => {
      const reply = await post(request("tools/list"), { accept: "application/json" });
      expect(reply.status).toBe(406);
      expectValid(reply);
    });

    it("refuses a body that is not application/json", async () => {
      const reply = await post(request("tools/list"), { "content-type": "text/plain" });
      expect(reply.status).toBe(415);
      expectValid(reply);
    });

    it("answers malformed JSON with 400, -32700 and no id", async () => {
      const reply = await post(undefined, {}, "{not json");
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
      expectValid(reply);
    });

    it("refuses batches", async () => {
      const reply = await post([request("tools/list")]);
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32600);
      expectValid(reply);
    });

    it("refuses a posted response", async () => {
      const reply = await post({ jsonrpc: "2.0", id: 1, result: {} });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32600);
      expectValid(reply);
    });

    it("ignores a session id and never mints one", async () => {
      const reply = await post(request("tools/list"), { "mcp-session-id": "abc" });
      expect(reply.status).toBe(200);
      expect(reply.headers.get("mcp-session-id")).toBeNull();
    });
  });

  describe("legacy clients", () => {
    it("answers initialize with the versions it serves", async () => {
      const reply = await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } },
        },
        { "mcp-protocol-version": undefined, "mcp-method": undefined },
      );
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32022);
      expect(reply.body.error.data).toEqual({ supported: [REVISION], requested: "2025-11-25" });
      expectValid(reply, "UnsupportedProtocolVersionError");
    });

    it("names the header version when an envelope-less request carries one", async () => {
      const reply = await post(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { "mcp-protocol-version": "2025-06-18", "mcp-method": undefined },
      );
      expect(reply.status).toBe(400);
      expect(reply.body.error.data).toEqual({ supported: [REVISION], requested: "2025-06-18" });
      expectValid(reply, "UnsupportedProtocolVersionError");
    });

    it("leaves requested out when the request names no version", async () => {
      const reply = await post(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { "mcp-protocol-version": undefined },
      );
      expect(reply.status).toBe(400);
      expect(reply.body.error.data).toEqual({ supported: [REVISION] });
    });

    it("treats initialize with a modern header as a header mismatch", async () => {
      const reply = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32020);
      expectValid(reply, "HeaderMismatchError");
    });
  });

  describe("envelope", () => {
    it("requires _meta when the header names this revision", async () => {
      const reply = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32602);
      expect(reply.body.error.data).toEqual({ envelope: { missing: ["_meta"] } });
      expectValid(reply);
    });

    it("requires clientCapabilities", async () => {
      const { "io.modelcontextprotocol/clientCapabilities": _, ...meta } = META;
      const reply = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32602);
      expect(reply.body.error.message).toContain("clientCapabilities: missing");
      expectValid(reply);
    });

    it("rejects a malformed clientInfo", async () => {
      const meta = { ...META, "io.modelcontextprotocol/clientInfo": { name: "x" } };
      const reply = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32602);
      expectValid(reply);
    });

    it("answers an unsupported version with -32022 and both versions", async () => {
      const meta = { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" };
      const reply = await post(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
        { "mcp-protocol-version": "2099-01-01" },
      );
      expect(reply.status).toBe(400);
      expect(reply.body.error.data).toEqual({ supported: [REVISION], requested: "2099-01-01" });
      expectValid(reply, "UnsupportedProtocolVersionError");
    });
  });

  describe("standard headers", () => {
    const call = request("tools/call", { name: "echo", arguments: { text: "hi" } });

    it.each([
      ["a version header that disagrees with _meta", { "mcp-protocol-version": "2025-11-25" }],
      ["a missing MCP-Protocol-Version", { "mcp-protocol-version": undefined }],
      ["an Mcp-Method that disagrees with the body", { "mcp-method": "tools/list" }],
      ["a missing Mcp-Method", { "mcp-method": undefined }],
      ["a missing Mcp-Name", { "mcp-name": undefined }],
      ["an Mcp-Name that disagrees with the body", { "mcp-name": "other" }],
      ["a malformed Base64 Mcp-Name", { "mcp-name": "=?base64?***?=" }],
    ])("rejects %s with 400 and -32020", async (_case, headers) => {
      const reply = await post(call, headers);
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32020);
      expect(reply.body.id).toBe(1);
      expectValid(reply, "HeaderMismatchError");
    });

    it("decodes a Base64 Mcp-Name before comparing it", async () => {
      const encoded = `=?base64?${Buffer.from("echo").toString("base64")}?=`;
      const reply = await post(call, { "mcp-name": encoded });
      expect(reply.status).toBe(200);
      expect(reply.body.result.content).toEqual([{ type: "text", text: "Echo: hi" }]);
    });

    it("ignores optional whitespace around header values", async () => {
      const reply = await post(call, { "mcp-method": "  tools/call\t", "mcp-name": " echo " });
      expect(reply.status).toBe(200);
    });

    it("compares header names case-insensitively", async () => {
      const reply = await post(call, {
        "mcp-protocol-version": undefined,
        "mcp-method": undefined,
        "mcp-name": undefined,
        "MCP-PROTOCOL-VERSION": REVISION,
        "MCP-METHOD": "tools/call",
        "MCP-NAME": "echo",
      });
      expect(reply.status).toBe(200);
    });
  });
});
