import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connectClient } from "./client.ts";
import { type RunningServer, startServer, stopServer } from "./server.ts";

// The contract guarantee: every endpoint must work with the official SDK as
// the client. No endpoint exists yet, so for now this only proves the harness
// runs end to end: the server starts and the real client's server/discover
// probe reaches it, gets the 404 of an unmounted path and fails negotiation.
// Phase 1 replaces it with /2026-07-28/mcp tests.
describe("official SDK harness", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  it("reaches the server with the official client", async () => {
    const connecting = connectClient(`${running.origin}/2026-07-28/mcp`, {
      mode: { pin: "2026-07-28" },
    });
    await expect(connecting).rejects.toThrow(/did not offer pinned protocol version 2026-07-28/);
  });

  it.todo("connects to /2026-07-28/mcp pinned to the modern revision");
});
