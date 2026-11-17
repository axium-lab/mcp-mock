import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connectClient, recordingFetch } from "../../client.ts";
import { validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// The official SDK as a legacy client (initialize handshake) narrowed to
// 2025-11-25 uses the endpoint end to end, and every byte the mock answers it
// with is a valid 2025-11-25 message.
const REVISION = "2025-11-25";
const legacy = { mode: "legacy" as const, supportedProtocolVersions: [REVISION] };

describe("2025-11-25 through the official SDK", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/${REVISION}/mcp`;
  });
  afterAll(() => stopServer(running.server));

  it("initializes, lists and calls echo", async () => {
    const recorder = recordingFetch();
    const client = await connectClient(url, { ...legacy, fetch: recorder.fetch });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);

    const result = await client.callTool({ name: "echo", arguments: { text: "Hello!" } });
    expect(result.content).toEqual([{ type: "text", text: "Echo: Hello!" }]);

    await client.close();

    expect(recorder.bodies.length).toBeGreaterThanOrEqual(3);
    for (const body of recorder.bodies) {
      expect(validateMessage(REVISION, body)).toEqual({ valid: true, errors: [] });
    }
  });

  it("reports the server identity from initialize", async () => {
    const client = await connectClient(url, legacy);
    expect(client.getServerVersion()).toMatchObject({ name: "mcp-mock" });
    await client.close();
  });

  it("answers ping", async () => {
    const client = await connectClient(url, legacy);
    await expect(client.ping()).resolves.toBeDefined();
    await client.close();
  });

  it("returns invalid arguments as a tool execution error", async () => {
    const client = await connectClient(url, legacy);
    const result = await client.callTool({ name: "echo", arguments: { text: 42 } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("surfaces an unknown tool as a protocol error", async () => {
    const client = await connectClient(url, legacy);
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toThrow(/Unknown tool: nope/);
    await client.close();
  });

  it("is reached by a dual-era client falling back to legacy", async () => {
    const client = await connectClient(url, { mode: "auto" });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    await client.close();
  });

  it("refuses a client pinned to the modern revision", async () => {
    await expect(connectClient(url, { mode: { pin: "2026-07-28" } })).rejects.toThrow();
  });

  it("answers with its own version, which a client that only speaks 2025-06-18 rejects", async () => {
    await expect(
      connectClient(url, { mode: "legacy", supportedProtocolVersions: ["2025-06-18"] }),
    ).rejects.toThrow(/2025-11-25/);
  });
});
