import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { connectClient, connectSseClient } from "../client.ts";
import { validateMessage } from "../schema.ts";
import { type RunningServer, startServer, stopServer } from "../server.ts";
import { openSse } from "../sse.ts";

// Controlling answers from the test, end to end: per-call _meta through the
// official SDK on every revision and transport, and forced HTTP failures.
const RESPONSE = "com.mcp-mock/response";
const ERROR = "com.mcp-mock/error";

describe("control from the test", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  describe("forced tools/call results through the SDK", () => {
    it("replaces a modern result, structured content included", async () => {
      const client = await connectClient(`${running.origin}/mcp`, { mode: { pin: "2026-07-28" } });
      const result = await client.callTool({
        name: "get_weather",
        arguments: { city: "Madrid" },
        _meta: { [RESPONSE]: { structuredContent: { city: "Madrid", temperature: 40 } } },
      });
      expect(result.structuredContent).toEqual({ city: "Madrid", temperature: 40 });
      expect(result.content).toEqual([{ type: "text", text: '{"city":"Madrid","temperature":40}' }]);
      await client.close();
    });

    it("forces a tool execution error on a legacy client", async () => {
      const client = await connectClient(`${running.origin}/mcp`, { mode: "legacy" });
      const result = await client.callTool({
        name: "send_email",
        arguments: { to: "ada@example.com", subject: "s", body: "b" },
        _meta: { [RESPONSE]: { text: "SMTP relay refused the message", isError: true } },
      });
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "SMTP relay refused the message" }] });
      await client.close();
    });

    it("answers for tools outside the catalog and skips argument validation", async () => {
      const client = await connectClient(`${running.origin}/mcp`, { mode: { pin: "2026-07-28" } });
      const result = await client.callTool({
        name: "not_in_catalog",
        arguments: { anything: [1, 2, 3] },
        _meta: { [RESPONSE]: { text: "ok" } },
      });
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      await client.close();
    });

    it("works over the 2024-11-05 SSE transport", async () => {
      const client = await connectSseClient(`${running.origin}/2024-11-05/sse`, ["2024-11-05"]);
      const result = await client.callTool({ name: "echo", arguments: { text: "x" }, _meta: { [RESPONSE]: { text: "forced" } } });
      expect(result.content).toEqual([{ type: "text", text: "forced" }]);
      await client.close();
    });
  });

  describe("forced JSON-RPC errors through the SDK", () => {
    it.each([
      ["2026-07-28", { mode: { pin: "2026-07-28" } as const }],
      ["legacy", { mode: "legacy" as const }],
    ])("fails a tools/call with the given code and message (%s)", async (_era, options) => {
      const client = await connectClient(`${running.origin}/mcp`, options);
      await expect(
        client.callTool({
          name: "echo",
          arguments: { text: "x" },
          _meta: { [ERROR]: { code: -32603, message: "Upstream exploded" } },
        }),
      ).rejects.toThrow(/Upstream exploded/);
      // The next call, without _meta, is unaffected: nothing is remembered.
      const result = await client.callTool({ name: "echo", arguments: { text: "x" } });
      expect(result.content).toEqual([{ type: "text", text: "Echo: x" }]);
      await client.close();
    });
  });

  describe("the wire format of each revision", () => {
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${running.origin}${path}`, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
    };
    const call = (meta: Record<string, unknown>, id = 1) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "add", arguments: { a: 1, b: 2 }, _meta: meta },
    });

    it("adapts a forced result to 2025-03-26, dropping structured content", async () => {
      const reply = await post("/2025-03-26/mcp", call({ [RESPONSE]: { structuredContent: { sum: 99 } } }));
      expect(reply.body.result).toEqual({ content: [{ type: "text", text: '{"sum":99}' }] });
      expect(validateMessage("2025-03-26", reply.body)).toEqual({ valid: true, errors: [] });
    });

    it("drops audio from a forced result on 2024-11-05, which had none", async () => {
      const sse = await openSse(`${running.origin}/2024-11-05/sse`);
      const body = await sse.call(
        call({
          [RESPONSE]: {
            content: [
              { type: "text", text: "a" },
              { type: "audio", data: "AAAA", mimeType: "audio/wav" },
            ],
          },
        }),
      );
      expect(body.result.content).toEqual([{ type: "text", text: "a" }]);
      expect(validateMessage("2024-11-05", body)).toEqual({ valid: true, errors: [] });
      sse.close();
    });

    it("forces an error on any method, in-band with HTTP 200 on 2026-07-28", async () => {
      const meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        [ERROR]: { code: -32001, message: "Rate limited upstream", data: { retryAfterMs: 500 } },
      };
      const reply = await post(
        "/2026-07-28/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      );
      expect(reply.status).toBe(200);
      expect(reply.body.error).toEqual({ code: -32001, message: "Rate limited upstream", data: { retryAfterMs: 500 } });
      expect(validateMessage("2026-07-28", reply.body)).toEqual({ valid: true, errors: [] });
    });

    it("forces errors per element in a 2025-03-26 batch", async () => {
      const reply = await post("/2025-03-26/mcp", [call({}, 1), call({ [ERROR]: { code: -32000, message: "no" } }, 2)]);
      expect(reply.body[0].result.content[0].text).toBe('{"sum":3}');
      expect(reply.body[1].error).toEqual({ code: -32000, message: "no" });
    });

    it("answers a malformed control value with invalid params", async () => {
      const reply = await post("/2025-11-25/mcp", call({ [RESPONSE]: { text: 1 } }));
      expect(reply.body.error.code).toBe(-32602);
      expect(reply.body.error.message).toContain("com.mcp-mock/response");
    });
  });

  describe("forced HTTP failures", () => {
    const post = (path: string, status: string, headers: Record<string, string> = {}) =>
      fetch(`${running.origin}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "x-mcp-mock-status": status,
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });

    it.each(["/mcp", "/2026-07-28/mcp", "/2025-11-25/mcp", "/2025-06-18/mcp", "/2025-03-26/mcp"])(
      "fails %s with the forced status and a JSON-RPC error body",
      async (path) => {
        const res = await post(path, "503");
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { code: number; message: string } };
        expect(body.error).toEqual({ code: -32000, message: "Service Unavailable: the server is temporarily unavailable." });
      },
    );

    it("adds Retry-After to a forced 429", async () => {
      const res = await post("/mcp", "429");
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("1");
    });

    it("shapes the body by revision: id: null on 2025-06-18", async () => {
      const res = await post("/2025-06-18/mcp", "500");
      expect(((await res.json()) as { id: unknown }).id).toBeNull();
    });

    it("refuses an invalid value with 400 instead of ignoring it", async () => {
      const res = await post("/mcp", "200");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain("x-mcp-mock-status");
    });

    it("still answers transport refusals first", async () => {
      const res = await post("/mcp", "503", { accept: "application/json" });
      expect(res.status).toBe(406);
    });

    it("fails the 2024-11-05 stream and its messages in plain text", async () => {
      const opened = await fetch(`${running.origin}/2024-11-05/sse`, { headers: { "x-mcp-mock-status": "502" } });
      expect(opened.status).toBe(502);
      expect(await opened.text()).toBe("Bad Gateway.");

      const sse = await openSse(`${running.origin}/2024-11-05/sse`);
      const res = await fetch(sse.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mcp-mock-status": "429" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("1");
      sse.close();
    });

    it("surfaces as an HTTP error in the official SDK", async () => {
      const client = new Client({ name: "t", version: "0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${running.origin}/mcp`), {
        requestInit: { headers: { "x-mcp-mock-status": "503" } },
      });
      // The SDK's message carries the error body rather than the status.
      await expect(client.connect(transport)).rejects.toThrow(/Service Unavailable/);
    });
  });
});
