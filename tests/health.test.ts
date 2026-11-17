import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { type RunningServer, startServer, stopServer } from "./server.ts";

// /health belongs to no MCP revision: it is the mock's own endpoint, so it is
// tested with plain fetch rather than through an SDK.
describe("health", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  it("reports the status and the running version", async () => {
    const res = await fetch(`${running.origin}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: pkg.version });
  });

  it("answers unknown paths with a JSON 404", async () => {
    const res = await fetch(`${running.origin}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: "Unknown request URL: GET /nope" } });
  });
});
