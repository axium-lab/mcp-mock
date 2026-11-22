import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { RevisionId } from "../../src/core/revisions.ts";
import { connectClient, connectSseClient, recordingFetch } from "../client.ts";
import { validateAgainst, validateMessage } from "../schema.ts";
import { type RunningServer, startServer, stopServer } from "../server.ts";

// Resources and prompts in every revision: usable through the official SDK,
// schema-valid on the wire, deterministic, and pinned by snapshots.
const RESOURCE_URIS = [
  "file:///etc/app/config.json",
  "file:///docs/README.md",
  "file:///data/report.csv",
  "file:///images/logo.png",
];
const PROMPTS: Record<string, Record<string, string>> = {
  summarize: { text: "MCP lets models use tools.", style: "detailed" },
  code_review: { code: "let x = 1", language: "javascript" },
  weather_report: { city: "Madrid" },
};

describe("resources and prompts", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  describe("through the official SDK", () => {
    it("lists and reads resources and gets prompts on 2026-07-28", async () => {
      const recorder = recordingFetch();
      const client = await connectClient(`${running.origin}/mcp`, { mode: { pin: "2026-07-28" }, fetch: recorder.fetch });

      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toEqual(RESOURCE_URIS);
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual(["weather://{city}", "user://{user_id}", "file:///{path}"]);

      const config = await client.readResource({ uri: "file:///etc/app/config.json" });
      expect(config.contents[0]).toMatchObject({ uri: "file:///etc/app/config.json", mimeType: "application/json" });
      const logo = await client.readResource({ uri: "file:///images/logo.png" });
      expect(logo.contents[0]).toMatchObject({ mimeType: "image/png" });
      expect(Buffer.from((logo.contents[0] as { blob: string }).blob, "base64").subarray(1, 4).toString()).toBe("PNG");
      const weather = await client.readResource({ uri: "weather://Madrid" });
      expect(JSON.parse((weather.contents[0] as { text: string }).text)).toMatchObject({ city: "Madrid" });

      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toEqual(Object.keys(PROMPTS));
      const report = await client.getPrompt({ name: "weather_report", arguments: { city: "Madrid" } });
      expect(report.messages[1]?.content).toMatchObject({ type: "resource", resource: { uri: "weather://Madrid" } });

      await client.close();
      for (const body of recorder.bodies) expect(validateMessage("2026-07-28", body)).toEqual({ valid: true, errors: [] });
    });

    it.each([["2025-11-25"], ["2025-06-18"], ["2025-03-26"]])("works on legacy %s", async (revision) => {
      const recorder = recordingFetch();
      const client = await connectClient(`${running.origin}/mcp`, {
        mode: "legacy",
        supportedProtocolVersions: [revision],
        fetch: recorder.fetch,
      });
      const { resources } = await client.listResources();
      expect(resources).toHaveLength(4);
      const titles = revision !== "2025-03-26";
      expect(resources[0]?.title).toBe(titles ? "Application configuration" : undefined);
      await client.listPrompts();
      // The SDK's types drop argument titles, so the wire is checked instead.
      const list = recorder.bodies.find((body) => (body as { result?: { prompts?: unknown } }).result?.prompts) as {
        result: { prompts: { arguments: { title?: string }[] }[] };
      };
      expect(list.result.prompts[0]?.arguments[0]?.title).toBe(titles ? "Text" : undefined);
      await client.readResource({ uri: "user://u_42" });
      await client.getPrompt({ name: "summarize", arguments: { text: "hi" } });
      await client.close();
      for (const body of recorder.bodies) expect(validateMessage(revision as RevisionId, body)).toEqual({ valid: true, errors: [] });
    });

    it("works over the 2024-11-05 SSE transport", async () => {
      const client = await connectSseClient(`${running.origin}/2024-11-05/sse`, ["2024-11-05"]);
      const { resources } = await client.listResources();
      expect(resources[0]?.title).toBeUndefined();
      const read = await client.readResource({ uri: "file:///docs/README.md" });
      expect(read.contents[0]).toMatchObject({ mimeType: "text/markdown" });
      const prompt = await client.getPrompt({ name: "code_review", arguments: { code: "x" } });
      expect(prompt.messages).toHaveLength(1);
      await client.close();
    });
  });

  describe("errors", () => {
    async function rpc(path: string, method: string, params: Record<string, unknown>, modern = false) {
      const meta = modern
        ? { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } }
        : {};
      const name = typeof params.uri === "string" ? params.uri : typeof params.name === "string" ? params.name : undefined;
      const res = await fetch(`${running.origin}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(modern ? { "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...meta } }),
      });
      return { status: res.status, body: (await res.json()) as any };
    }

    it.each([
      ["file:///missing"],
      ["weather://Atlantis"],
      ["weather://%E0%A4%A"],
      ["user://missing"],
      ["user://%ZZ"],
      ["ftp://example.com/x"],
      ["file:///a/../etc/passwd"],
    ])(
      "answers %s with resource-not-found: -32002 on legacy, -32602 on 2026-07-28",
      async (uri) => {
        const legacy = await rpc("/2025-11-25/mcp", "resources/read", { uri });
        expect(legacy.body.error).toEqual({ code: -32002, message: "Resource not found", data: { uri } });
        expect(validateMessage("2025-11-25", legacy.body).valid).toBe(true);
        const modern = await rpc("/2026-07-28/mcp", "resources/read", { uri }, true);
        expect(modern.status).toBe(200);
        expect(modern.body.error).toEqual({ code: -32602, message: "Resource not found", data: { uri } });
      },
    );

    it("requires the Mcp-Name header for resources/read and prompts/get on 2026-07-28", async () => {
      for (const [method, params] of [
        ["resources/read", { uri: "file:///docs/README.md" }],
        ["prompts/get", { name: "summarize", arguments: { text: "x" } }],
      ] as const) {
        const res = await fetch(`${running.origin}/2026-07-28/mcp`, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
          }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32020);
      }
    });

    it.each([
      ["an unknown prompt", { name: "nope" }, "unknown prompt: nope"],
      ["a missing required argument", { name: "summarize", arguments: {} }, 'missing required argument "text"'],
      ["an unknown argument", { name: "summarize", arguments: { text: "x", tone: "sad" } }, 'unknown argument "tone"'],
      ["a non-string argument", { name: "summarize", arguments: { text: 1 } }, 'argument "text" must be a string'],
      ["an invalid style", { name: "summarize", arguments: { text: "x", style: "long" } }, 'argument "style" must be one of'],
      ["a city that does not exist", { name: "weather_report", arguments: { city: "Atlantis" } }, "city not found: Atlantis"],
    ])("refuses %s with -32602", async (_case, params, message) => {
      const reply = await rpc("/2025-11-25/mcp", "prompts/get", params);
      expect(reply.body.error.code).toBe(-32602);
      expect(reply.body.error.message).toContain(message);
    });
  });

  // Snapshots per revision. 2024-11-05 shares its shape with 2025-03-26 and
  // is covered through the SDK above.
  describe.each([["2026-07-28"], ["2025-11-25"], ["2025-06-18"], ["2025-03-26"]])("wire format of %s", (revision) => {
    const modern = revision === "2026-07-28";
    async function result(method: string, params: Record<string, unknown> = {}) {
      const name = typeof params.uri === "string" ? params.uri : typeof params.name === "string" ? params.name : undefined;
      const meta = modern
        ? { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } }
        : {};
      const send = () =>
        fetch(`${running.origin}/${revision}/mcp`, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": revision,
            ...(modern ? { "mcp-method": method, ...(name ? { "mcp-name": name } : {}) } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...meta } }),
        }).then((res) => res.text());
      const text = await send();
      expect(await send()).toBe(text);
      const body = JSON.parse(text);
      expect(validateMessage(revision as RevisionId, body)).toEqual({ valid: true, errors: [] });
      const { _meta, ...rest } = body.result;
      return rest;
    }

    it("lists resources, templates and prompts", async () => {
      const resources = await result("resources/list");
      expect(validateAgainst(revision as RevisionId, "ListResourcesResult", resources).valid).toBe(true);
      expect(resources).toMatchSnapshot();
      expect(await result("resources/templates/list")).toMatchSnapshot();
      expect(await result("prompts/list")).toMatchSnapshot();
    });

    it.each([...RESOURCE_URIS, "weather://Oslo", "user://u_1"])("reads %s", async (uri) => {
      const read = await result("resources/read", { uri });
      expect(validateAgainst(revision as RevisionId, "ReadResourceResult", read).valid).toBe(true);
      expect(read).toMatchSnapshot();
    });

    it.each(Object.keys(PROMPTS))("gets the %s prompt", async (name) => {
      const prompt = await result("prompts/get", { name, arguments: PROMPTS[name] });
      expect(validateAgainst(revision as RevisionId, "GetPromptResult", prompt).valid).toBe(true);
      expect(prompt).toMatchSnapshot();
    });
  });
});
