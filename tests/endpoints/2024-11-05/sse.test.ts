import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";
import { openSse } from "../../sse.ts";

// The 2024-11-05 HTTP+SSE transport byte by byte: the stream, the endpoint
// event, the plain-text POST answers, and every message valid against the
// 2024-11-05 schema.
const REVISION = "2024-11-05";
const INITIALIZE = (version: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

describe("2024-11-05 over raw HTTP+SSE", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/${REVISION}/sse`;
  });
  afterAll(() => stopServer(running.server));

  it("opens an event stream whose first event names the message endpoint", async () => {
    const sse = await openSse(url);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    expect(sse.endpointData).toMatch(/^\/2024-11-05\/messages\?sessionId=[0-9a-f-]{36}$/);
    sse.close();
  });

  it("answers POSTs with 202 Accepted and the response on the stream", async () => {
    const sse = await openSse(url);
    const accepted = await sse.post(INITIALIZE("2024-11-05"));
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe("Accepted");

    const message = await sse.next();
    expect(message.event).toBe("message");
    const body = JSON.parse(message.data);
    expect(body.result).toEqual({
      protocolVersion: REVISION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "mcp-mock", version: "0.0.0" },
    });
    expect(validateMessage(REVISION, body)).toEqual({ valid: true, errors: [] });
    sse.close();
  });

  it("serves tools in the 2024-11-05 vocabulary, every message schema-valid", async () => {
    const sse = await openSse(url);
    const messages = [
      await sse.call(INITIALIZE("2024-11-05")),
      await sse.call({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      await sse.call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_web", arguments: { query: "mcp", limit: 2 } } }),
      await sse.call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "color_swatch", arguments: { color: "red", size: 1 } } }),
      await sse.call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: {} } }),
    ];
    for (const message of messages) expect(validateMessage(REVISION, message)).toEqual({ valid: true, errors: [] });

    const tools = messages[1].result.tools;
    expect(Object.keys(tools[10])).toEqual(["name", "description", "inputSchema"]);
    expect(messages[2].result.content.map((block: { type: string }) => block.type)).toEqual(["text"]);
    expect(messages[3].result.content[0].type).toBe("image");
    expect(messages[4].error.code).toBe(-32602);
    sse.close();
  });

  it("accepts notifications and responses with 202 and nothing on the stream", async () => {
    const sse = await openSse(url);
    expect((await sse.post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await sse.post({ jsonrpc: "2.0", id: 9, result: {} })).status).toBe(202);
    // The next thing on the stream is the answer to this ping, nothing before.
    expect(await sse.call({ jsonrpc: "2.0", id: 10, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 10, result: {} });
    sse.close();
  });

  it("answers unknown methods on the stream with -32601", async () => {
    const sse = await openSse(url);
    const body = await sse.call({ jsonrpc: "2.0", id: 1, method: "completion/complete" });
    expect(body.error.code).toBe(-32601);
    sse.close();
  });

  describe("refusals", () => {
    it("rejects a POST for an unknown session with 404", async () => {
      const res = await fetch(`${running.origin}/2024-11-05/messages?sessionId=nope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Session not found");
    });

    it("forgets a session once its stream closes", async () => {
      const sse = await openSse(url);
      sse.close();
      await Bun.sleep(20);
      expect((await sse.post({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
    });

    it.each([
      ["malformed JSON", { raw: "{not json" }],
      ["an invalid message", { raw: JSON.stringify({ jsonrpc: "1.0", method: "ping" }) }],
      ["a batch, which this revision does not have", { raw: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]) }],
      ["a body that is not JSON", { contentType: "text/plain", raw: "ping" }],
    ])("rejects %s with 400", async (_case, init) => {
      const sse = await openSse(url);
      const res = await sse.post(undefined, init);
      expect(res.status).toBe(400);
      sse.close();
    });

    it("keeps each session to itself", async () => {
      const a = await openSse(url);
      const b = await openSse(url);
      expect(a.endpoint).not.toBe(b.endpoint);
      expect(await b.call({ jsonrpc: "2.0", id: "b", method: "ping" })).toMatchObject({ id: "b" });
      expect(await a.call({ jsonrpc: "2.0", id: "a", method: "ping" })).toMatchObject({ id: "a" });
      a.close();
      b.close();
    });
  });

  describe("at the root, next to /mcp", () => {
    it("names a root message endpoint", async () => {
      const sse = await openSse(`${running.origin}/sse`);
      expect(sse.endpointData).toMatch(/^\/messages\?sessionId=/);
      sse.close();
    });

    it("remembers the version negotiated by initialize for the session", async () => {
      const sse = await openSse(`${running.origin}/sse`);
      expect((await sse.call(INITIALIZE("2025-06-18"))).result.protocolVersion).toBe("2025-06-18");
      // 2025-06-18 rules now apply: titles and structured content are back.
      const list = await sse.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(list.result.tools[0].title).toBe("Echo");
      expect(validateMessage("2025-06-18", list)).toEqual({ valid: true, errors: [] });
      sse.close();
    });

    it("accepts batches once a session negotiated 2025-03-26", async () => {
      const sse = await openSse(`${running.origin}/sse`);
      await sse.call(INITIALIZE("2025-03-26"));
      const answers = await sse.call([
        { jsonrpc: "2.0", id: 2, method: "ping" },
        { jsonrpc: "2.0", id: 3, method: "ping" },
      ]);
      expect(answers.map((answer: { id: number }) => answer.id)).toEqual([2, 3]);
      sse.close();
    });

    it("serves 2024-11-05 before initialize and to clients that ask for it", async () => {
      const sse = await openSse(`${running.origin}/sse`);
      expect((await sse.call(INITIALIZE("2024-11-05"))).result.protocolVersion).toBe("2024-11-05");
      sse.close();
    });
  });
});
