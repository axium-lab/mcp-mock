import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// What 2025-06-18 does differently from 2025-11-25: invalid arguments are a
// protocol error, and an error without a readable request id says `id: null`.
const REVISION = "2025-06-18";

interface Reply {
  status: number;
  headers: Headers;
  // Arbitrary JSON: each test asserts the shape it expects.
  body: any;
}

describe("2025-06-18 over raw HTTP", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  async function post(
    body: unknown,
    headers: Record<string, string> = {},
    raw?: string,
    path = `/${REVISION}/mcp`,
  ): Promise<Reply> {
    const res = await fetch(`${running.origin}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": REVISION,
        ...headers,
      },
      body: raw ?? JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  const call = (name: string, args: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });

  it("initializes as 2025-06-18", async () => {
    const reply = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(reply.body.result.protocolVersion).toBe(REVISION);
    expect(validateMessage(REVISION, reply.body).valid).toBe(true);
  });

  it("answers invalid arguments with an in-band -32602", async () => {
    const reply = await post(call("echo", { text: 42 }));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: 'Invalid arguments for tool echo: "text" must be a string, got number' },
    });
    expect(validateMessage(REVISION, reply.body).valid).toBe(true);
  });

  it("keeps business failures as tool execution errors", async () => {
    const reply = await post(call("calculate", { expression: "1/0" }));
    expect(reply.body.result.isError).toBe(true);
    expect(validateMessage(REVISION, reply.body).valid).toBe(true);
  });

  it("serves the catalog's structured content and resource links unchanged", async () => {
    const reply = await post(call("search_web", { query: "mcp", limit: 1 }));
    expect(reply.body.result.content.map((block: { type: string }) => block.type)).toEqual([
      "text",
      "resource_link",
    ]);
    expect(reply.body.result.structuredContent.results).toHaveLength(1);
    expect(validateMessage(REVISION, reply.body).valid).toBe(true);
  });

  describe("errors without a readable id carry id: null", () => {
    it.each([
      ["malformed JSON", () => post(undefined, {}, "{not json"), 400],
      ["a batch", () => post([{ jsonrpc: "2.0", id: 1, method: "ping" }]), 400],
      ["an invalid message", () => post({ jsonrpc: "1.0", method: "ping" }), 400],
      ["an unacceptable Accept header", () => post({ jsonrpc: "2.0", id: 1, method: "ping" }, { accept: "text/html" }), 406],
      ["a version header it does not serve", () => post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2025-11-25" }), 400],
    ])("on %s", async (_case, send, status) => {
      const reply = await send();
      expect(reply.status).toBe(status);
      expect(reply.body.id).toBeNull();
      expect("id" in reply.body).toBe(true);
    });

    it("on GET", async () => {
      const res = await fetch(`${running.origin}/${REVISION}/mcp`);
      expect(res.status).toBe(405);
      expect(((await res.json()) as { id: unknown }).id).toBeNull();
    });
  });

  describe("through the dual-era /mcp", () => {
    it("negotiates 2025-06-18 when the client asks for it", async () => {
      const reply = await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: REVISION, capabilities: {}, clientInfo: { name: "t", version: "0" } },
        },
        {},
        undefined,
        "/mcp",
      );
      expect(reply.body.result.protocolVersion).toBe(REVISION);
    });

    it("serves requests whose header names 2025-06-18 as 2025-06-18", async () => {
      const reply = await post(call("echo", { text: 42 }), {}, undefined, "/mcp");
      expect(reply.body.error.code).toBe(-32602);
    });

    it("serves the same request as 2025-11-25 when the header says so", async () => {
      const reply = await post(call("echo", { text: 42 }), { "mcp-protocol-version": "2025-11-25" }, undefined, "/mcp");
      expect(reply.body.result.isError).toBe(true);
    });

    it("shapes transport refusals by the revision the header names", async () => {
      const as0618 = await fetch(`${running.origin}/mcp`, { headers: { "mcp-protocol-version": REVISION } });
      expect(as0618.status).toBe(405);
      expect(((await as0618.json()) as { id: unknown }).id).toBeNull();
      const bare = await fetch(`${running.origin}/mcp`);
      expect("id" in ((await bare.json()) as object)).toBe(false);
      const malformed = await post(undefined, {}, "{not json", "/mcp");
      expect(malformed.body.id).toBeNull();
    });

    it("shapes an invalid message by the revision its header names", async () => {
      const as0618 = await post({ jsonrpc: "1.0", method: "ping" }, {}, undefined, "/mcp");
      expect(as0618.body.id).toBeNull();
      const as1125 = await post({ jsonrpc: "1.0", method: "ping" }, { "mcp-protocol-version": "2025-11-25" }, undefined, "/mcp");
      expect("id" in as1125.body).toBe(false);
    });
  });
});
