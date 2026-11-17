import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TOOL_NAMES } from "../../catalog.ts";
import { connectClient, recordingFetch } from "../../client.ts";
import { validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// The official SDK as a legacy client narrowed to 2025-03-26 uses the
// endpoint end to end, receives the catalog in that revision's vocabulary,
// and every byte it receives is a valid 2025-03-26 message.
const REVISION = "2025-03-26";
const legacy = { mode: "legacy" as const, supportedProtocolVersions: [REVISION] };

describe("2025-03-26 through the official SDK", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/${REVISION}/mcp`;
  });
  afterAll(() => stopServer(running.server));

  it("initializes, lists and calls tools in the 2025-03-26 shape", async () => {
    const recorder = recordingFetch();
    const client = await connectClient(url, { ...legacy, fetch: recorder.fetch });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    const weatherTool = tools.find((tool) => tool.name === "get_weather");
    expect(weatherTool?.outputSchema).toBeUndefined();
    expect(weatherTool?.annotations?.title).toBe("Current weather");

    const weather = await client.callTool({ name: "get_weather", arguments: { city: "Madrid" } });
    expect(weather.structuredContent).toBeUndefined();
    const text = (weather.content as { type: string; text: string }[])[0]?.text as string;
    expect(JSON.parse(text)).toMatchObject({ city: "Madrid" });

    await client.close();

    expect((recorder.bodies[0] as { result: { protocolVersion: string } }).result.protocolVersion).toBe(REVISION);
    for (const body of recorder.bodies) {
      expect(validateMessage(REVISION, body)).toEqual({ valid: true, errors: [] });
    }
  });

  it("reports invalid arguments as a protocol error", async () => {
    const client = await connectClient(url, legacy);
    await expect(client.callTool({ name: "echo", arguments: {} })).rejects.toThrow(/"text" is required/);
    await client.close();
  });

  it("answers with its own version, which a 2025-06-18-only client rejects", async () => {
    await expect(
      connectClient(url, { mode: "legacy", supportedProtocolVersions: ["2025-06-18"] }),
    ).rejects.toThrow(/2025-03-26/);
  });
});
