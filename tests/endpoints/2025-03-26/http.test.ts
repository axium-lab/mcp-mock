import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// What 2025-03-26 adds and takes away: JSON-RPC batches, no MCP-Protocol-
// Version header, and a catalog without the 2025-06-18 additions.
const REVISION = "2025-03-26";

interface Reply {
  status: number;
  headers: Headers;
  // Arbitrary JSON: each test asserts the shape it expects.
  body: any;
}

describe("2025-03-26 over raw HTTP", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  // No MCP-Protocol-Version: this revision did not have it.
  async function post(body: unknown, headers: Record<string, string> = {}, path = `/${REVISION}/mcp`): Promise<Reply> {
    const res = await fetch(`${running.origin}${path}`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  const request = (id: number, method: string, params?: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id,
    method,
    ...(params ? { params } : {}),
  });

  function expectValid(reply: Reply): void {
    expect(validateMessage(REVISION, reply.body)).toEqual({ valid: true, errors: [] });
  }

  describe("catalog", () => {
    it("lists tools without titles or output schemas, the title kept in annotations", async () => {
      const reply = await post(request(1, "tools/list"));
      const weather = reply.body.result.tools.find((tool: { name: string }) => tool.name === "get_weather");
      expect(Object.keys(weather)).toEqual(["name", "description", "inputSchema", "annotations"]);
      expect(weather.annotations).toEqual({
        title: "Current weather",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expectValid(reply);
    });

    it("returns structured tools as JSON text only", async () => {
      const reply = await post(request(1, "tools/call", { name: "add", arguments: { a: 1, b: 2 } }));
      expect(reply.body.result).toEqual({ content: [{ type: "text", text: '{"sum":3}' }] });
      expectValid(reply);
    });

    it("drops resource links, keeping the URLs in the text", async () => {
      const reply = await post(request(1, "tools/call", { name: "search_web", arguments: { query: "mcp", limit: 2 } }));
      expect(reply.body.result.content.map((block: { type: string }) => block.type)).toEqual(["text"]);
      expect(reply.body.result.content[0].text).toContain("https://example.com/mcp/1-");
      expectValid(reply);
    });

    it("keeps images and embedded resources, which this revision has", async () => {
      const image = await post(request(1, "tools/call", { name: "color_swatch", arguments: { color: "red", size: 1 } }));
      expect(image.body.result.content[0].type).toBe("image");
      expectValid(image);
      const file = await post(request(2, "tools/call", { name: "read_file", arguments: { path: "/a.md" } }));
      expect(file.body.result.content[0].type).toBe("resource");
      expectValid(file);
    });

    it("keeps isError on tool execution errors", async () => {
      const reply = await post(request(1, "tools/call", { name: "get_user", arguments: { user_id: "missing" } }));
      expect(reply.body.result.isError).toBe(true);
      expectValid(reply);
    });
  });

  describe("batches", () => {
    it("answers a batch of requests with an array of responses, in order", async () => {
      const reply = await post([
        request(1, "ping"),
        request(2, "tools/call", { name: "add", arguments: { a: 2, b: 2 } }),
        request(3, "tools/call", { name: "nope", arguments: {} }),
      ]);
      expect(reply.status).toBe(200);
      expect(reply.body.map((response: { id: number }) => response.id)).toEqual([1, 2, 3]);
      expect(reply.body[0].result).toEqual({});
      expect(reply.body[1].result.content[0].text).toBe('{"sum":4}');
      expect(reply.body[2].error.code).toBe(-32602);
      expectValid(reply);
    });

    it("answers only the requests of a mixed batch", async () => {
      const reply = await post([{ jsonrpc: "2.0", method: "notifications/initialized" }, request(9, "ping")]);
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual([{ jsonrpc: "2.0", id: 9, result: {} }]);
    });

    it("accepts a batch of notifications with 202", async () => {
      const reply = await post([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      ]);
      expect(reply.status).toBe(202);
      expect(reply.body).toBeUndefined();
    });

    it("accepts a batch of responses with 202", async () => {
      const reply = await post([{ jsonrpc: "2.0", id: 1, result: {} }]);
      expect(reply.status).toBe(202);
    });

    it("answers a malformed element in place without failing the others", async () => {
      const reply = await post([{ jsonrpc: "1.0", id: 4, method: "ping" }, 42, request(5, "ping")]);
      expect(reply.status).toBe(200);
      expect(reply.body[0]).toMatchObject({ id: 4, error: { code: -32600 } });
      expect(reply.body[1]).toMatchObject({ id: null, error: { code: -32600 } });
      expect(reply.body[2]).toEqual({ jsonrpc: "2.0", id: 5, result: {} });
      expectValid(reply);
    });

    it("refuses initialize inside a batch", async () => {
      const reply = await post([
        request(1, "initialize", { protocolVersion: REVISION, capabilities: {}, clientInfo: { name: "t", version: "0" } }),
      ]);
      expect(reply.body[0]).toMatchObject({ id: 1, error: { code: -32600 } });
      expect(reply.body[0].error.message).toContain("initialize must not be part of a JSON-RPC batch");
    });

    it.each([
      ["an empty batch", []],
      ["responses mixed with requests", [{ jsonrpc: "2.0", id: 1, result: {} }, request(2, "ping")]],
    ])("refuses %s with 400", async (_case, batch) => {
      const reply = await post(batch);
      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ id: null, error: { code: -32600 } });
    });

    it("stays refused on the revisions that removed batching", async () => {
      const reply = await post([request(1, "ping")], {}, "/2025-06-18/mcp");
      expect(reply.status).toBe(400);
    });
  });

  describe("through the dual-era /mcp", () => {
    it("serves a request without a version header as 2025-03-26", async () => {
      const reply = await post(request(1, "tools/call", { name: "add", arguments: { a: 1, b: 2 } }), {}, "/mcp");
      expect(reply.body.result).toEqual({ content: [{ type: "text", text: '{"sum":3}' }] });
    });

    it("accepts batches without a header, and refuses them under a 2025-06-18 header", async () => {
      const batch = [request(1, "ping"), request(2, "ping")];
      const bare = await post(batch, {}, "/mcp");
      expect(bare.status).toBe(200);
      expect(bare.body).toHaveLength(2);
      const as0618 = await post(batch, { "mcp-protocol-version": "2025-06-18" }, "/mcp");
      expect(as0618.status).toBe(400);
    });

    it("negotiates 2025-03-26 when the client asks for it", async () => {
      const reply = await post(
        request(1, "initialize", { protocolVersion: REVISION, capabilities: {}, clientInfo: { name: "t", version: "0" } }),
        {},
        "/mcp",
      );
      expect(reply.body.result.protocolVersion).toBe(REVISION);
    });
  });
});
