import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TOOL_NAMES } from "../../catalog.ts";
import { connectSseClient } from "../../client.ts";
import { type RunningServer, startServer, stopServer } from "../../server.ts";

// The official SDK's SSEClientTransport against the 2024-11-05 transport,
// pinned and at the root next to /mcp.
describe("2024-11-05 through the official SDK", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  it("connects over SSE pinned to 2024-11-05 and uses the catalog in its shape", async () => {
    const client = await connectSseClient(`${running.origin}/2024-11-05/sse`, ["2024-11-05"]);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    const weatherTool = tools.find((tool) => tool.name === "get_weather");
    expect(weatherTool?.annotations).toBeUndefined();
    expect(weatherTool?.title).toBeUndefined();

    const echo = await client.callTool({ name: "echo", arguments: { text: "Hello!" } });
    expect(echo.content).toEqual([{ type: "text", text: "Echo: Hello!" }]);
    const weather = await client.callTool({ name: "get_weather", arguments: { city: "Madrid" } });
    expect(weather.structuredContent).toBeUndefined();
    await client.close();
  });

  it("negotiates 2024-11-05 with a client that asks for a newer version", async () => {
    // The SDK offers 2025-11-25 first and accepts 2024-11-05, which it knows.
    const client = await connectSseClient(`${running.origin}/2024-11-05/sse`);
    expect(client.getServerVersion()).toMatchObject({ name: "mcp-mock" });
    const { tools } = await client.listTools();
    expect(tools.every((tool) => tool.annotations === undefined)).toBe(true);
    await client.close();
  });

  it("reports invalid arguments as a protocol error", async () => {
    const client = await connectSseClient(`${running.origin}/2024-11-05/sse`, ["2024-11-05"]);
    await expect(client.callTool({ name: "echo", arguments: {} })).rejects.toThrow(/"text" is required/);
    await client.close();
  });

  it("serves the SSE transport at the root too, negotiating newer revisions over it", async () => {
    const client = await connectSseClient(`${running.origin}/sse`);
    const { tools } = await client.listTools();
    // The SDK asked for 2025-11-25, which the root serves: full catalog.
    expect(tools.find((tool) => tool.name === "get_weather")?.title).toBe("Current weather");
    const weather = await client.callTool({ name: "get_weather", arguments: { city: "Madrid" } });
    expect(weather.structuredContent).toMatchObject({ city: "Madrid" });
    await client.close();
  });

  it("serves 2024-11-05 at the root to a client that only speaks it", async () => {
    const client = await connectSseClient(`${running.origin}/sse`, ["2024-11-05"]);
    const { tools } = await client.listTools();
    expect(tools.every((tool) => tool.annotations === undefined)).toBe(true);
    await client.close();
  });
});
