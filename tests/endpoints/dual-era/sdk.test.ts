import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TOOL_NAMES } from "../../catalog.ts";
import { connectClient, recordingFetch } from "../../client.ts";
import { validateMessage } from "../../schema.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// The spec's compatibility matrix, with the official SDK playing each kind of
// client against the dual-era /mcp: every one of them must work, and each
// must be answered in its own era's wire format.
describe("dual-era /mcp through the official SDK", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/mcp`;
  });
  afterAll(() => stopServer(running.server));

  async function useEcho(client: Awaited<ReturnType<typeof connectClient>>): Promise<void> {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    const result = await client.callTool({ name: "echo", arguments: { text: "Hello!" } });
    expect(result.content).toEqual([{ type: "text", text: "Echo: Hello!" }]);
    await client.close();
  }

  it("serves a modern client as 2026-07-28", async () => {
    const recorder = recordingFetch();
    await useEcho(await connectClient(url, { mode: { pin: "2026-07-28" }, fetch: recorder.fetch }));
    for (const body of recorder.bodies) {
      expect(validateMessage("2026-07-28", body)).toEqual({ valid: true, errors: [] });
    }
  });

  it("serves a legacy client as 2025-11-25", async () => {
    const recorder = recordingFetch();
    await useEcho(
      await connectClient(url, {
        mode: "legacy",
        supportedProtocolVersions: ["2025-11-25"],
        fetch: recorder.fetch,
      }),
    );
    for (const body of recorder.bodies) {
      expect(validateMessage("2025-11-25", body)).toEqual({ valid: true, errors: [] });
    }
  });

  it("serves a legacy client with the SDK's default version list", async () => {
    await useEcho(await connectClient(url, { mode: "legacy" }));
  });

  it("keeps a dual-era client modern", async () => {
    const recorder = recordingFetch();
    await useEcho(await connectClient(url, { mode: "auto", fetch: recorder.fetch }));
    const results = recorder.bodies.map((body) => (body as { result?: { resultType?: string } }).result);
    expect(results.every((result) => result?.resultType === "complete")).toBe(true);
  });

  it("offers its own legacy version to a client that cannot take it", async () => {
    await expect(
      connectClient(url, { mode: "legacy", supportedProtocolVersions: ["2025-06-18"] }),
    ).rejects.toThrow(/2025-11-25/);
  });
});
