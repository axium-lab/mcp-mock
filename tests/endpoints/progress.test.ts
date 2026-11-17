import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { RevisionId } from "../../src/core/revisions.ts";
import { connectClient, connectSseClient } from "../client.ts";
import { validateMessage } from "../schema.ts";
import { type RunningServer, startServer, stopServer } from "../server.ts";
import { openSse } from "../sse.ts";

// Progress notifications and cancellation, with simulate_work as the slow
// tool: through the official SDK on every revision and transport, and byte by
// byte on the wire.
const WORK = { name: "simulate_work", arguments: { steps: 3, step_ms: 5 } };

interface ProgressEvent {
  progress: number;
  total?: number;
  message?: string;
}

describe("progress and cancellation", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  describe("progress through the SDK", () => {
    it.each([
      ["2026-07-28", { mode: { pin: "2026-07-28" } as const }],
      ["2025-11-25", { mode: "legacy" as const, supportedProtocolVersions: ["2025-11-25"] }],
      ["2025-03-26", { mode: "legacy" as const, supportedProtocolVersions: ["2025-03-26"] }],
    ])("reports each step before the result on %s", async (_revision, options) => {
      const client = await connectClient(`${running.origin}/mcp`, options);
      const seen: ProgressEvent[] = [];
      const result = await client.callTool(WORK, { onprogress: (progress) => seen.push(progress as ProgressEvent) });
      expect(seen).toEqual([
        { progress: 1, total: 3, message: "Step 1 of 3" },
        { progress: 2, total: 3, message: "Step 2 of 3" },
        { progress: 3, total: 3, message: "Step 3 of 3" },
      ]);
      expect(result.structuredContent ?? JSON.parse((result.content as { text: string }[])[0]?.text as string)).toEqual({
        steps: 3,
        completed: true,
      });
      await client.close();
    });

    it("reports progress without messages on 2024-11-05", async () => {
      const client = await connectSseClient(`${running.origin}/2024-11-05/sse`, ["2024-11-05"]);
      const seen: ProgressEvent[] = [];
      try {
        const result = await client.callTool(
          { name: "simulate_work", arguments: { steps: 3, step_ms: 30 } },
          { onprogress: (progress) => seen.push(progress as ProgressEvent) },
        );
        expect(JSON.parse((result.content as { text: string }[])[0]?.text as string)).toEqual({ steps: 3, completed: true });
        // The SDK's SSE client handles progress asynchronously and may drop the
        // last one when the response follows right behind it; the full sequence
        // is checked on the wire below. What it does receive has no message.
        for (const progress of seen) {
          expect(progress.total).toBe(3);
          expect(progress.message).toBeUndefined();
        }
      } finally {
        await client.close();
      }
    });

    it("cancels a request the SDK aborts on 2026-07-28", async () => {
      const client = await connectClient(`${running.origin}/mcp`, { mode: { pin: "2026-07-28" } });
      const controller = new AbortController();
      const call = client.callTool(
        { name: "simulate_work", arguments: { steps: 20, step_ms: 50 } },
        { signal: controller.signal, onprogress: () => controller.abort() },
      );
      await expect(call).rejects.toThrow();
      // The server is still serving afterwards.
      const echo = await client.callTool({ name: "echo", arguments: { text: "still here" } });
      expect(echo.content).toEqual([{ type: "text", text: "Echo: still here" }]);
      await client.close();
    });
  });

  describe("on the wire", () => {
    async function stream(path: string, headers: Record<string, string>, params: Record<string, unknown>) {
      const res = await fetch(`${running.origin}${path}`, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params }),
      });
      const text = await res.text();
      const events = res.headers.get("content-type")?.includes("text/event-stream")
        ? text
            .split("\n\n")
            .filter(Boolean)
            .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))?.slice(6) as string))
        : [JSON.parse(text)];
      return { status: res.status, contentType: res.headers.get("content-type"), events };
    }
    const modernMeta = (extra: Record<string, unknown> = {}) => ({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      ...extra,
    });
    const modernHeaders = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "simulate_work" };

    it("streams progress then the result over SSE on 2026-07-28, every event schema-valid", async () => {
      const reply = await stream("/2026-07-28/mcp", modernHeaders, { ...WORK, _meta: modernMeta({ progressToken: "t-1" }) });
      expect(reply.status).toBe(200);
      expect(reply.contentType).toContain("text/event-stream");
      expect(reply.events.map((event) => event.method ?? "result")).toEqual([
        "notifications/progress",
        "notifications/progress",
        "notifications/progress",
        "result",
      ]);
      expect(reply.events[0].params).toEqual({ progressToken: "t-1", progress: 1, total: 3, message: "Step 1 of 3" });
      expect(reply.events[3]).toMatchObject({ id: 7, result: { resultType: "complete", structuredContent: { steps: 3, completed: true } } });
      for (const event of reply.events) expect(validateMessage("2026-07-28", event)).toEqual({ valid: true, errors: [] });
    });

    it("answers with plain JSON when no progress token is given", async () => {
      const reply = await stream("/2026-07-28/mcp", modernHeaders, { ...WORK, _meta: modernMeta() });
      expect(reply.contentType).toContain("application/json");
      expect(reply.events).toHaveLength(1);
    });

    it("answers with plain JSON when the method reports no progress", async () => {
      const reply = await stream(
        "/2026-07-28/mcp",
        { ...modernHeaders, "mcp-name": "echo" },
        { name: "echo", arguments: { text: "x" }, _meta: modernMeta({ progressToken: 1 }) },
      );
      expect(reply.contentType).toContain("application/json");
    });

    it("keeps the HTTP 400 of -32021 even when progress was asked for", async () => {
      const reply = await stream(
        "/2026-07-28/mcp",
        { ...modernHeaders, "mcp-name": "delete_file" },
        { name: "delete_file", arguments: { path: "/a" }, _meta: modernMeta({ progressToken: 1 }) },
      );
      expect(reply.status).toBe(400);
      expect(reply.events[0].error.code).toBe(-32021);
    });

    it.each([
      ["2025-11-25", true],
      ["2025-06-18", true],
      ["2025-03-26", true],
    ])("streams progress on legacy %s (message: %p)", async (revision, withMessage) => {
      const reply = await stream(`/${revision}/mcp`, { "mcp-protocol-version": revision }, { ...WORK, _meta: { progressToken: "p" } });
      expect(reply.contentType).toContain("text/event-stream");
      expect(reply.events).toHaveLength(4);
      expect("message" in reply.events[0].params).toBe(withMessage);
      for (const event of reply.events) expect(validateMessage(revision as RevisionId, event)).toEqual({ valid: true, errors: [] });
    });

    it("accepts notifications/cancelled on legacy Streamable HTTP and ignores it", async () => {
      const res = await fetch(`${running.origin}/2025-11-25/mcp`, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }),
      });
      expect(res.status).toBe(202);
    });

    it("stops a 2026-07-28 request whose stream the client closes", async () => {
      const controller = new AbortController();
      const res = await fetch(`${running.origin}/2026-07-28/mcp`, {
        method: "POST",
        signal: controller.signal,
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...modernHeaders },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "simulate_work", arguments: { steps: 20, step_ms: 20 }, _meta: modernMeta({ progressToken: 1 }) },
        }),
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain("notifications/progress");
      controller.abort();
      // The server keeps answering other requests.
      const after = await stream("/2026-07-28/mcp", { ...modernHeaders, "mcp-name": "echo" }, { name: "echo", arguments: { text: "x" }, _meta: modernMeta() });
      expect(after.status).toBe(200);
    });

    describe("on the 2024-11-05 SSE transport", () => {
      it("sends progress events on the session stream before the response", async () => {
        const sse = await openSse(`${running.origin}/2024-11-05/sse`);
        await sse.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { ...WORK, _meta: { progressToken: "s" } } });
        const events = [await sse.next(), await sse.next(), await sse.next(), await sse.next()].map((event) => JSON.parse(event.data));
        expect(events.map((event) => event.method ?? "result")).toEqual([
          "notifications/progress",
          "notifications/progress",
          "notifications/progress",
          "result",
        ]);
        expect(events[0].params).toEqual({ progressToken: "s", progress: 1, total: 3 });
        for (const event of events) expect(validateMessage("2024-11-05", event)).toEqual({ valid: true, errors: [] });
        sse.close();
      });

      it("cancels a running request with notifications/cancelled and never answers it", async () => {
        const sse = await openSse(`${running.origin}/2024-11-05/sse`);
        await sse.post({
          jsonrpc: "2.0",
          id: "slow",
          method: "tools/call",
          params: { name: "simulate_work", arguments: { steps: 20, step_ms: 20 }, _meta: { progressToken: "s" } },
        });
        expect(JSON.parse((await sse.next()).data).method).toBe("notifications/progress");
        await sse.post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow", reason: "test" } });
        // Whatever progress was already in flight may still arrive; the next
        // response on the stream must be the ping's, not the cancelled call's.
        await sse.post({ jsonrpc: "2.0", id: "ping", method: "ping" });
        for (;;) {
          const message = JSON.parse((await sse.next()).data);
          if (message.method === "notifications/progress") continue;
          expect(message).toEqual({ jsonrpc: "2.0", id: "ping", result: {} });
          break;
        }
        sse.close();
      });
    });
  });
});
