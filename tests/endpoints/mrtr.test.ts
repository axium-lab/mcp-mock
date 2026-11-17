import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connectClient } from "../client.ts";
import { validateAgainst, validateMessage } from "../schema.ts";
import { type RunningServer, startServer, stopServer } from "../server.ts";

// Multi round-trip requests (2026-07-28): delete_file asks for confirmation,
// and a test can force any input request through _meta. The official SDK
// fulfils input_required results with its elicitation handler and retries
// on its own.
const INPUT_REQUIRED = "com.mcp-mock/input-required";
const RESPONSE = "com.mcp-mock/response";

describe("multi round-trip requests", () => {
  let running: RunningServer;
  let url: string;
  beforeAll(async () => {
    running = await startServer();
    url = `${running.origin}/2026-07-28/mcp`;
  });
  afterAll(() => stopServer(running.server));

  describe("delete_file through the SDK", () => {
    it("asks for confirmation and deletes on accept", async () => {
      const asked: Record<string, unknown>[] = [];
      const client = await connectClient(url, {
        mode: { pin: "2026-07-28" },
        onElicit: (params) => {
          asked.push(params);
          return { action: "accept", content: { confirm: true } };
        },
      });
      const result = await client.callTool({ name: "delete_file", arguments: { path: "/tmp/old.log" } });
      expect(result.structuredContent).toEqual({ path: "/tmp/old.log", deleted: true });
      expect(asked).toHaveLength(1);
      expect(asked[0]?.message).toBe("Delete /tmp/old.log? This cannot be undone.");
      await client.close();
    });

    it.each([
      ["declines", { action: "decline" }],
      ["cancels", { action: "cancel" }],
      ["accepts without confirming", { action: "accept", content: { confirm: false } }],
    ])("does not delete when the user %s", async (_case, answer) => {
      const client = await connectClient(url, { mode: { pin: "2026-07-28" }, onElicit: () => answer });
      const result = await client.callTool({ name: "delete_file", arguments: { path: "/tmp/old.log" } });
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Deletion cancelled: /tmp/old.log was not deleted" }] });
      await client.close();
    });

    it("fails with -32021 for a client without elicitation", async () => {
      const client = await connectClient(url, { mode: { pin: "2026-07-28" } });
      await expect(client.callTool({ name: "delete_file", arguments: { path: "/tmp/old.log" } })).rejects.toThrow(
        /Missing required client capability/,
      );
      await client.close();
    });

    it("deletes without asking on legacy revisions, which cannot ask", async () => {
      let asked = false;
      const client = await connectClient(`${running.origin}/mcp`, {
        mode: "legacy",
        onElicit: () => {
          asked = true;
          return { action: "decline" };
        },
      });
      const result = await client.callTool({ name: "delete_file", arguments: { path: "/tmp/old.log" } });
      expect(result.structuredContent).toEqual({ path: "/tmp/old.log", deleted: true });
      expect(asked).toBe(false);
      await client.close();
    });
  });

  describe("input requests forced from the test", () => {
    const elicitName = {
      who: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Who are you?",
          requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        },
      },
    };

    it("asks what the test says and returns what the client answered", async () => {
      const client = await connectClient(url, {
        mode: { pin: "2026-07-28" },
        onElicit: () => ({ action: "accept", content: { name: "octocat" } }),
      });
      const result = await client.callTool({
        name: "echo",
        arguments: { text: "x" },
        _meta: { [INPUT_REQUIRED]: { inputRequests: elicitName, requestState: "opaque-1" } },
      });
      expect(result.structuredContent).toEqual({
        inputResponses: { who: { action: "accept", content: { name: "octocat" } } },
        requestState: "opaque-1",
      });
      await client.close();
    });

    it("returns the forced result after the round trip when one is given", async () => {
      const client = await connectClient(url, {
        mode: { pin: "2026-07-28" },
        onElicit: () => ({ action: "accept", content: { name: "octocat" } }),
      });
      const result = await client.callTool({
        name: "echo",
        arguments: { text: "x" },
        _meta: { [INPUT_REQUIRED]: { inputRequests: elicitName }, [RESPONSE]: { text: "Welcome, octocat" } },
      });
      expect(result.content).toEqual([{ type: "text", text: "Welcome, octocat" }]);
      await client.close();
    });
  });

  describe("over raw HTTP", () => {
    const META = (capabilities: Record<string, unknown>) => ({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": capabilities,
    });
    async function call(params: Record<string, unknown>, capabilities: Record<string, unknown> = { elicitation: {} }) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": params.name as string,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { ...params, _meta: { ...(params._meta as object), ...META(capabilities) } },
        }),
      });
      return { status: res.status, body: (await res.json()) as any };
    }
    const deleteFile = { name: "delete_file", arguments: { path: "/tmp/a.txt" } };

    it("answers the first call with a schema-valid input_required result", async () => {
      const reply = await call(deleteFile);
      expect(reply.status).toBe(200);
      expect(reply.body.result.resultType).toBe("input_required");
      expect(Object.keys(reply.body.result.inputRequests)).toEqual(["confirm_delete"]);
      expect(typeof reply.body.result.requestState).toBe("string");
      expect(reply.body.result.ttlMs).toBeUndefined();
      expect(validateMessage("2026-07-28", reply.body)).toEqual({ valid: true, errors: [] });
      expect(validateAgainst("2026-07-28", "InputRequiredResult", reply.body.result)).toEqual({ valid: true, errors: [] });
    });

    it("is stateless: the same first call always gets the same requestState", async () => {
      expect((await call(deleteFile)).body).toEqual((await call(deleteFile)).body);
    });

    it("completes the retry that echoes the requestState", async () => {
      const first = await call(deleteFile);
      const retry = await call({
        ...deleteFile,
        inputResponses: { confirm_delete: { action: "accept", content: { confirm: true } } },
        requestState: first.body.result.requestState,
      });
      expect(retry.body.result).toMatchObject({ resultType: "complete", structuredContent: { deleted: true } });
      expect(validateMessage("2026-07-28", retry.body)).toEqual({ valid: true, errors: [] });
    });

    it.each([
      ["a tampered requestState", "tampered"],
      ["the requestState of another file", null],
    ])("refuses %s", async (_case, state) => {
      const other = (await call({ name: "delete_file", arguments: { path: "/tmp/b.txt" } })).body.result.requestState;
      const retry = await call({
        ...deleteFile,
        inputResponses: { confirm_delete: { action: "accept", content: { confirm: true } } },
        requestState: state ?? other,
      });
      expect(retry.body.error.code).toBe(-32602);
      expect(retry.body.error.message).toContain("requestState");
    });

    it("asks again when the retry lacks the answer it needs", async () => {
      const first = await call(deleteFile);
      const retry = await call({ ...deleteFile, inputResponses: {}, requestState: first.body.result.requestState });
      expect(retry.body.result.resultType).toBe("input_required");
    });

    it.each([
      ["no elicitation at all", {}],
      ["only URL elicitation", { elicitation: { url: {} } }],
    ])("answers %s with HTTP 400 and -32021", async (_case, capabilities) => {
      const reply = await call(deleteFile, capabilities);
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32021);
      expect(reply.body.error.data).toEqual({ requiredCapabilities: { elicitation: { form: {} } } });
      expect(validateAgainst("2026-07-28", "MissingRequiredClientCapabilityError", reply.body)).toEqual({ valid: true, errors: [] });
    });

    it("refuses a forced input request on legacy revisions", async () => {
      const res = await fetch(`${running.origin}/2025-11-25/mcp`, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "x" }, _meta: { [INPUT_REQUIRED]: { requestState: "s" } } },
        }),
      });
      const body = (await res.json()) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain("2026-07-28");
    });

    it("refuses a malformed forced input request", async () => {
      const reply = await call({ name: "echo", arguments: { text: "x" }, _meta: { [INPUT_REQUIRED]: {} } });
      expect(reply.body.error.code).toBe(-32602);
      expect(reply.body.error.message).toContain('"inputRequests" or "requestState"');
    });
  });
});
