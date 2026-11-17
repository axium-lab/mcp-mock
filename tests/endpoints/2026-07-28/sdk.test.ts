import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TOOL_NAMES } from "../../catalog.ts";
import { connectClient, recordingFetch } from "../../client.ts";
import { validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// The contract guarantee: the official SDK, pinned to 2026-07-28, uses the
// endpoint end to end, and every byte the mock answers it with is a valid
// 2026-07-28 message.
describe("2026-07-28 through the official SDK", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/2026-07-28/mcp`;
  });
  afterAll(() => stopServer(running.server));

  it("connects pinned to the modern revision, lists and calls echo", async () => {
    const recorder = recordingFetch();
    const client = await connectClient(url, { mode: { pin: "2026-07-28" }, fetch: recorder.fetch });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);

    const result = await client.callTool({ name: "echo", arguments: { text: "Hello!" } });
    expect(result.content).toEqual([{ type: "text", text: "Echo: Hello!" }]);

    await client.close();

    expect(recorder.bodies.length).toBeGreaterThanOrEqual(3);
    for (const body of recorder.bodies) {
      expect(validateMessage("2026-07-28", body)).toEqual({ valid: true, errors: [] });
    }
  });

  it("reports the server identity from server/discover", async () => {
    const client = await connectClient(url, { mode: { pin: "2026-07-28" } });
    expect(client.getServerVersion()).toMatchObject({ name: "mcp-mock" });
    await client.close();
  });

  it("passes unicode through untouched", async () => {
    const client = await connectClient(url, { mode: { pin: "2026-07-28" } });
    const result = await client.callTool({ name: "echo", arguments: { text: "¡Hola, 世界! 👋" } });
    expect(result.content).toEqual([{ type: "text", text: "Echo: ¡Hola, 世界! 👋" }]);
    await client.close();
  });

  it("returns invalid arguments as a tool execution error", async () => {
    const client = await connectClient(url, { mode: { pin: "2026-07-28" } });
    const result = await client.callTool({ name: "echo", arguments: { text: 42 } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("surfaces an unknown tool as a protocol error", async () => {
    const client = await connectClient(url, { mode: { pin: "2026-07-28" } });
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toThrow(/Unknown tool: nope/);
    await client.close();
  });

  it("stays modern with a dual-era client", async () => {
    const client = await connectClient(url, { mode: "auto" });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    await client.close();
  });

  it("refuses a legacy-only client", async () => {
    await expect(connectClient(url, { mode: "legacy" })).rejects.toThrow();
  });
});
