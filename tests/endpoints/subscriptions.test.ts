import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connectClient, connectSseClient } from "../client.ts";
import { validateAgainst, validateMessage } from "../schema.ts";
import { type RunningServer, startServer, stopServer } from "../server.ts";
import { openSse } from "../sse.ts";

// Change notifications: subscriptions/listen on 2026-07-28, and
// resources/subscribe on the 2024-11-05 SSE transport, the one legacy
// transport with a stream to deliver them on. The changes are scripted from
// the test with _meta["com.mcp-mock/notifications"].
const SCRIPT = "com.mcp-mock/notifications";
const README = "file:///docs/README.md";

describe("change notifications", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  describe("subscriptions/listen through the SDK", () => {
    it("is acknowledged with the honored filter and closes locally", async () => {
      const client = await connectClient(`${running.origin}/mcp`, { mode: { pin: "2026-07-28" } });
      const subscription = await client.listen({
        toolsListChanged: true,
        resourceSubscriptions: [README, "file:///missing"],
      });
      // The missing resource cannot be honored, so it is left out.
      expect(subscription.honoredFilter).toEqual({ toolsListChanged: true, resourceSubscriptions: [README] });
      await subscription.close();
      expect(await subscription.closed).toBe("local");
      // The connection still serves requests.
      const echo = await client.callTool({ name: "echo", arguments: { text: "x" } });
      expect(echo.content).toEqual([{ type: "text", text: "Echo: x" }]);
      await client.close();
    });
  });

  describe("subscriptions/listen on the wire", () => {
    const META = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    function listen(params: Record<string, unknown>, id: number | string = 9) {
      return fetch(`${running.origin}/2026-07-28/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "subscriptions/listen",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "subscriptions/listen",
          params: { ...params, _meta: { ...META, ...(params._meta as object) } },
        }),
      });
    }
    async function events(res: Response) {
      const text = await res.text();
      return text
        .split("\n\n")
        .filter((block) => block.startsWith("event:"))
        .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))?.slice(6) as string));
    }

    it("acknowledges first, plays the script in order and ends gracefully", async () => {
      const res = await listen({
        notifications: { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: [README] },
        _meta: {
          [SCRIPT]: { events: ["toolsListChanged", { resourceUpdated: README }, "promptsListChanged"], intervalMs: 5, close: true },
        },
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const messages = await events(res);
      expect(messages.map((message) => message.method ?? "response")).toEqual([
        "notifications/subscriptions/acknowledged",
        "notifications/tools/list_changed",
        "notifications/resources/updated",
        "notifications/prompts/list_changed",
        "response",
      ]);
      expect(messages[0].params).toEqual({
        _meta: { "io.modelcontextprotocol/subscriptionId": 9 },
        notifications: { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: [README] },
      });
      expect(messages[2].params).toEqual({ _meta: { "io.modelcontextprotocol/subscriptionId": 9 }, uri: README });
      expect(messages[4]).toMatchObject({ id: 9, result: { resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": 9 } } });
      for (const message of messages) expect(validateMessage("2026-07-28", message)).toEqual({ valid: true, errors: [] });
      expect(validateAgainst("2026-07-28", "SubscriptionsAcknowledgedNotification", messages[0]).valid).toBe(true);
      expect(validateAgainst("2026-07-28", "SubscriptionsListenResultResponse", messages[4]).valid).toBe(true);
    });

    it("stays open and quiet without a script, until the client closes it", async () => {
      const controller = new AbortController();
      const res = await fetch(`${running.origin}/2026-07-28/mcp`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "subscriptions/listen",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: META } }),
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain("notifications/subscriptions/acknowledged");
      const next = await Promise.race([reader.read().then(() => "data"), Bun.sleep(100).then(() => "quiet")]);
      expect(next).toBe("quiet");
      controller.abort();
    });

    it("refuses a script that announces what was not subscribed", async () => {
      const res = await listen({ notifications: { toolsListChanged: true }, _meta: { [SCRIPT]: { events: ["promptsListChanged"] } } });
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain("promptsListChanged");
    });

    it("refuses a request without a notification filter", async () => {
      const body = (await (await listen({})).json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32602);
    });

    it("honors a forced error", async () => {
      const res = await listen({ notifications: {}, _meta: { "com.mcp-mock/error": { code: -32603, message: "no streams today" } } });
      expect(((await res.json()) as { error: unknown }).error).toEqual({ code: -32603, message: "no streams today" });
    });

    it("advertises listChanged and subscribe in server/discover", async () => {
      const res = await fetch(`${running.origin}/2026-07-28/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } }),
      });
      const body = (await res.json()) as { result: { capabilities: unknown } };
      expect(body.result.capabilities).toEqual({
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
      });
    });
  });

  describe("resources/subscribe on the 2024-11-05 SSE transport", () => {
    it("delivers scripted updates through the SDK", async () => {
      const client = await connectSseClient(`${running.origin}/2024-11-05/sse`, ["2024-11-05"]);
      expect(client.getServerCapabilities()?.resources).toEqual({ subscribe: true });
      const updates: string[] = [];
      client.setNotificationHandler("notifications/resources/updated", (notification) => {
        updates.push(notification.params.uri);
      });
      await client.subscribeResource({ uri: README, _meta: { [SCRIPT]: { events: [{ resourceUpdated: README }, { resourceUpdated: README }], intervalMs: 5 } } });
      await Bun.sleep(60);
      expect(updates).toEqual([README, README]);
      await client.close();
    });

    it("stops the updates on unsubscribe", async () => {
      const sse = await openSse(`${running.origin}/2024-11-05/sse`);
      const subscribed = await sse.call({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/subscribe",
        params: { uri: README, _meta: { [SCRIPT]: { events: [{ resourceUpdated: README }], intervalMs: 200 } } },
      });
      expect(subscribed).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
      expect(await sse.call({ jsonrpc: "2.0", id: 2, method: "resources/unsubscribe", params: { uri: README } })).toMatchObject({ id: 2 });
      // The ping's answer comes next; the cancelled update never arrives.
      await Bun.sleep(250);
      expect(await sse.call({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
      sse.close();
    });

    it.each([
      ["a resource that does not exist", { uri: "file:///missing" }, -32002],
      ["a script for another resource", { uri: README, _meta: { [SCRIPT]: { events: [{ resourceUpdated: "file:///data/report.csv" }] } } }, -32602],
    ])("refuses %s", async (_case, params, code) => {
      const sse = await openSse(`${running.origin}/2024-11-05/sse`);
      const body = await sse.call({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params });
      expect(body.error.code).toBe(code);
      sse.close();
    });

    it("is not served on legacy Streamable HTTP, which has no stream to deliver on", async () => {
      const res = await fetch(`${running.origin}/2025-11-25/mcp`, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: README } }),
      });
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32601);
    });
  });
});
