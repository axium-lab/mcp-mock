import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TOOL_NAMES } from "../../catalog.ts";
import { connectClient, recordingFetch } from "../../client.ts";
import { validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// The official SDK as a legacy client narrowed to 2025-06-18 uses the
// endpoint end to end, and every byte it receives is a valid 2025-06-18
// message.
const REVISION = "2025-06-18";
const legacy = { mode: "legacy" as const, supportedProtocolVersions: [REVISION] };

describe("2025-06-18 through the official SDK", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/${REVISION}/mcp`;
  });
  afterAll(() => stopServer(running.server));

  it("initializes, lists and calls tools", async () => {
    const recorder = recordingFetch();
    const client = await connectClient(url, { ...legacy, fetch: recorder.fetch });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);

    const echo = await client.callTool({ name: "echo", arguments: { text: "Hello!" } });
    expect(echo.content).toEqual([{ type: "text", text: "Echo: Hello!" }]);

    const weather = await client.callTool({ name: "get_weather", arguments: { city: "Madrid" } });
    expect(weather.structuredContent).toMatchObject({ city: "Madrid" });

    await client.close();

    expect((recorder.bodies[0] as { result: { protocolVersion: string } }).result.protocolVersion).toBe(REVISION);
    for (const body of recorder.bodies) {
      expect(validateMessage(REVISION, body)).toEqual({ valid: true, errors: [] });
    }
  });

  it("reports invalid arguments as a protocol error", async () => {
    const client = await connectClient(url, legacy);
    await expect(client.callTool({ name: "echo", arguments: { text: 42 } })).rejects.toThrow(
      /"text" must be a string/,
    );
    await client.close();
  });

  it("still reports business failures as tool execution errors", async () => {
    const client = await connectClient(url, legacy);
    const result = await client.callTool({ name: "get_weather", arguments: { city: "Atlantis" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("is reached by a dual-era client falling back to legacy", async () => {
    const client = await connectClient(url, { mode: "auto", supportedProtocolVersions: [REVISION] });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(20);
    await client.close();
  });

  it("answers with its own version, which a 2025-11-25-only client rejects", async () => {
    await expect(
      connectClient(url, { mode: "legacy", supportedProtocolVersions: ["2025-11-25"] }),
    ).rejects.toThrow(/2025-06-18/);
  });
});
