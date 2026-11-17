import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { RevisionId } from "../../src/core/revisions.ts";
import { SAMPLES, TOOL_NAMES } from "../catalog.ts";
import { validateAgainst, validateMessage } from "../schema.ts";
import { type RunningServer, startServer, stopServer } from "../server.ts";

// Every tool over the wire, in every revision: valid against that revision's
// schema, byte-identical on repeat, and pinned by a snapshot so any change to
// the data a tool returns shows up in review. A changed snapshot is a
// breaking change for users who snapshot the mock's answers.
interface Wire {
  revision: RevisionId;
  headers: (method: string, name?: string) => Record<string, string>;
  params: (params: Record<string, unknown>) => Record<string, unknown>;
}

const WIRES: Wire[] = [
  {
    revision: "2026-07-28",
    headers: (method, name) => ({
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    }),
    params: (params) => ({
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    }),
  },
  {
    revision: "2025-11-25",
    headers: () => ({ "mcp-protocol-version": "2025-11-25" }),
    params: (params) => params,
  },
];

describe.each(WIRES.map((wire) => [wire.revision, wire] as const))("catalog over %s", (revision, wire) => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  async function rpc(method: string, params: Record<string, unknown>, name?: string): Promise<string> {
    const res = await fetch(`${running.origin}/${revision}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...wire.headers(method, name),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: wire.params(params) }),
    });
    expect(res.status).toBe(200);
    return res.text();
  }

  it("lists the whole catalog", async () => {
    const body = JSON.parse(await rpc("tools/list", {}));
    expect(validateMessage(revision, body)).toEqual({ valid: true, errors: [] });
    expect(validateAgainst(revision, "ListToolsResult", body.result)).toEqual({ valid: true, errors: [] });
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOL_NAMES);
    expect(body.result.tools).toMatchSnapshot();
  });

  it.each(TOOL_NAMES)("calls %s", async (name) => {
    const params = { name, arguments: SAMPLES[name] };
    const text = await rpc("tools/call", params, name);
    expect(await rpc("tools/call", params, name)).toBe(text);

    const body = JSON.parse(text);
    expect(validateMessage(revision, body)).toEqual({ valid: true, errors: [] });
    expect(validateAgainst(revision, "CallToolResult", body.result)).toEqual({ valid: true, errors: [] });
    expect(body.result.isError).toBeUndefined();
    // _meta carries the mock's version (2026-07-28 only), which changes with
    // every release without the tool's answer changing; it is tested apart.
    const { _meta, ...result } = body.result;
    expect(result).toMatchSnapshot();
  });
});
