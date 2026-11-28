import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { RevisionId } from "../../../src/core/revisions.ts";
import { validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// How /mcp picks the era of each request, and that every answer is valid for
// the era it was served in.
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface Reply {
  status: number;
  headers: Headers;
  // Arbitrary JSON: each test asserts the shape it expects.
  body: any;
}

describe("dual-era /mcp over raw HTTP", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/mcp`;
  });
  afterAll(() => stopServer(running.server));

  async function post(body: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Reply> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body: raw ?? JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  function expectValid(revision: RevisionId, reply: Reply): void {
    expect(validateMessage(revision, reply.body)).toEqual({ valid: true, errors: [] });
  }

  const modern = (method: string, params: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { ...params, _meta: META },
  });
  const modernHeaders = (method: string, name?: string): Record<string, string> => ({
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  });

  describe("modern traffic", () => {
    it("answers server/discover with the modern versions only", async () => {
      const reply = await post(modern("server/discover"), modernHeaders("server/discover"));
      expect(reply.status).toBe(200);
      expect(reply.body.result.supportedVersions).toEqual(["2026-07-28"]);
      expectValid("2026-07-28", reply);
    });

    it("serves tools/call in the modern format", async () => {
      const reply = await post(
        modern("tools/call", { name: "echo", arguments: { text: "hi" } }),
        modernHeaders("tools/call", "echo"),
      );
      expect(reply.status).toBe(200);
      expect(reply.body.result.resultType).toBe("complete");
      expectValid("2026-07-28", reply);
    });

    it("answers an unsupported modern version with -32022 listing modern versions", async () => {
      const meta = { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" };
      const reply = await post(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
        { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
      );
      expect(reply.status).toBe(400);
      expect(reply.body.error.data).toEqual({ supported: ["2026-07-28"], requested: "2099-01-01" });
      expectValid("2026-07-28", reply);
    });

    it("treats a modern header without _meta as a broken modern request, not a legacy one", async () => {
      const reply = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, modernHeaders("tools/list"));
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32602);
    });

    it("routes on the envelope even when the header disagrees", async () => {
      const reply = await post(modern("tools/list"), {
        ...modernHeaders("tools/list"),
        "mcp-protocol-version": "2025-11-25",
      });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32020);
    });

    it("acknowledges a modern notification with 202", async () => {
      const reply = await post(
        { jsonrpc: "2.0", method: "notifications/whatever", params: { _meta: META } },
        { "mcp-protocol-version": "2026-07-28" },
      );
      expect(reply.status).toBe(202);
    });

    it("refuses a batch containing a modern-enveloped request instead of falling back to 2025-03-26", async () => {
      const reply = await post([modern("tools/list")]);
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32600);
      expectValid("2026-07-28", reply);
    });
  });

  describe("legacy traffic", () => {
    it("initializes as 2025-11-25 without a session", async () => {
      const reply = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      expect(reply.status).toBe(200);
      expect(reply.body.result.protocolVersion).toBe("2025-11-25");
      expect(reply.headers.get("mcp-session-id")).toBeNull();
      expectValid("2025-11-25", reply);
    });

    it("serves a request without _meta in the legacy format", async () => {
      const reply = await post(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { "mcp-protocol-version": "2025-11-25" },
      );
      expect(reply.status).toBe(200);
      expect(Object.keys(reply.body.result)).toEqual(["tools"]);
      expectValid("2025-11-25", reply);
    });

    it("serves a legacy request that sends no version header", async () => {
      const reply = await post({ jsonrpc: "2.0", id: 2, method: "ping" });
      expect(reply.status).toBe(200);
      expect(reply.body.result).toEqual({});
    });

    it("refuses a legacy header naming a version it does not serve", async () => {
      const reply = await post(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { "mcp-protocol-version": "2024-01-01" },
      );
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32000);
    });

    it("accepts a legacy notification with 202", async () => {
      const reply = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      expect(reply.status).toBe(202);
    });
  });

  describe("transport", () => {
    it.each(["GET", "DELETE"])("refuses %s with 405", async (method) => {
      const res = await fetch(url, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    });

    it("answers malformed JSON with 400 and -32700", async () => {
      const reply = await post(undefined, {}, "{not json");
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32700);
    });

    it("refuses a client that does not accept both JSON and SSE", async () => {
      const reply = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { accept: "application/json" });
      expect(reply.status).toBe(406);
    });

    it("leaves the pinned endpoints untouched", async () => {
      const res = await fetch(`${running.origin}/2025-11-25/mcp`, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify(modern("server/discover")),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error?: { code: number } };
      // The pinned legacy endpoint does not know server/discover.
      expect(body.error?.code).toBe(-32601);
    });
  });
});
