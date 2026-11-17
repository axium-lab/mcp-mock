import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { validateMessage, validateTasksExtension } from "../schema.ts";
import { type RunningServer, startServer, stopServer } from "../server.ts";

// The tasks extension on 2026-07-28, kept stateless: the task id carries the
// call, so any tasks/get can work out the task's state. The official SDK has
// no client for this extension yet, so it is exercised on the wire and
// checked against the extension's own schema.
const EXT = "io.modelcontextprotocol/tasks";

describe("tasks extension", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  async function rpc(method: string, params: Record<string, unknown>, options: { tasks?: boolean; name?: string } = {}) {
    const capabilities = options.tasks === false ? {} : { extensions: { [EXT]: {} } };
    const name = options.name ?? (typeof params.taskId === "string" ? params.taskId : (params.name as string | undefined));
    const res = await fetch(`${running.origin}/2026-07-28/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": capabilities,
            ...(params._meta as object),
          },
        },
      }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }
  const work = (stepMs: number) => ({ name: "simulate_work", arguments: { steps: 2, step_ms: stepMs } });

  it("advertises the extension in server/discover", async () => {
    const reply = await rpc("server/discover", {});
    expect(reply.body.result.capabilities.extensions).toEqual({ [EXT]: {} });
  });

  it("turns simulate_work into a task for clients that declare the extension", async () => {
    const reply = await rpc("tools/call", work(50));
    expect(reply.status).toBe(200);
    const task = reply.body.result;
    expect(task).toMatchObject({ resultType: "task", status: "working", ttlMs: 3_600_000, pollIntervalMs: 100 });
    expect(task.taskId).toMatch(/^task_/);
    expect(validateMessage("2026-07-28", reply.body)).toEqual({ valid: true, errors: [] });
    expect(validateTasksExtension("CreateTaskResult", task)).toEqual({ valid: true, errors: [] });
  });

  it("answers synchronously for clients that do not declare it", async () => {
    const reply = await rpc("tools/call", work(1), { tasks: false });
    expect(reply.body.result).toMatchObject({ resultType: "complete", structuredContent: { steps: 2, completed: true } });
  });

  it("answers other tools synchronously even for declaring clients", async () => {
    const reply = await rpc("tools/call", { name: "echo", arguments: { text: "x" } });
    expect(reply.body.result.resultType).toBe("complete");
  });

  it("reports working, then completed with the result the call would have returned", async () => {
    const created = (await rpc("tools/call", work(40))).body.result;
    const working = await rpc("tasks/get", { taskId: created.taskId });
    expect(working.body.result).toMatchObject({ resultType: "complete", taskId: created.taskId, status: "working" });
    expect(working.body.result.statusMessage).toMatch(/^Working: \d+%$/);
    expect(validateTasksExtension("GetTaskResult", working.body.result)).toEqual({ valid: true, errors: [] });

    await Bun.sleep(100);
    const done = await rpc("tasks/get", { taskId: created.taskId });
    expect(done.body.result).toMatchObject({
      status: "completed",
      createdAt: created.createdAt,
      result: { resultType: "complete", structuredContent: { steps: 2, completed: true } },
    });
    expect(validateMessage("2026-07-28", done.body)).toEqual({ valid: true, errors: [] });
    expect(validateTasksExtension("GetTaskResult", done.body.result)).toEqual({ valid: true, errors: [] });
  });

  describe("tasks forced from the test", () => {
    it("makes a task of any tool, completing with its result", async () => {
      const created = (await rpc("tools/call", { name: "get_weather", arguments: { city: "Madrid" }, _meta: { "com.mcp-mock/task": {} } })).body.result;
      expect(created.resultType).toBe("task");
      const done = (await rpc("tasks/get", { taskId: created.taskId })).body.result;
      expect(done.status).toBe("completed");
      expect(done.result.structuredContent).toMatchObject({ city: "Madrid" });
    });

    it("completes a tool execution error, since it is a result", async () => {
      const created = (await rpc("tools/call", { name: "get_weather", arguments: { city: "Atlantis" }, _meta: { "com.mcp-mock/task": {} } })).body.result;
      const done = (await rpc("tasks/get", { taskId: created.taskId })).body.result;
      expect(done).toMatchObject({ status: "completed", result: { isError: true } });
    });

    it("fails on a JSON-RPC error, which the task carries", async () => {
      const created = (
        await rpc("tools/call", {
          name: "echo",
          arguments: { text: "x" },
          _meta: { "com.mcp-mock/task": {}, "com.mcp-mock/error": { code: -32603, message: "boom" } },
        })
      ).body;
      // A forced error wins before the task is even created.
      expect(created.error).toEqual({ code: -32603, message: "boom" });

      const failing = (await rpc("tools/call", { name: "nope", arguments: {}, _meta: { "com.mcp-mock/task": {} } })).body.result;
      const done = (await rpc("tasks/get", { taskId: failing.taskId })).body.result;
      expect(done).toMatchObject({ status: "failed", error: { code: -32602, message: "Unknown tool: nope" } });
      expect(done.statusMessage).toContain("Unknown tool: nope");
      expect(validateTasksExtension("GetTaskResult", done)).toEqual({ valid: true, errors: [] });
    });

    it("refuses a forced task for a client without the extension with -32021", async () => {
      const reply = await rpc("tools/call", { name: "echo", arguments: { text: "x" }, _meta: { "com.mcp-mock/task": {} } }, { tasks: false });
      expect(reply.status).toBe(400);
      expect(reply.body.error).toMatchObject({ code: -32021, data: { requiredCapabilities: { extensions: { [EXT]: {} } } } });
    });
  });

  describe("tasks/update and tasks/cancel", () => {
    it.each(["tasks/update", "tasks/cancel"])("%s acknowledges with an empty result", async (method) => {
      const created = (await rpc("tools/call", work(20))).body.result;
      const reply = await rpc(method, { taskId: created.taskId, ...(method === "tasks/update" && { inputResponses: {} }) });
      expect(reply.body.result).toMatchObject({ resultType: "complete" });
      expect(validateTasksExtension(method === "tasks/update" ? "UpdateTaskResult" : "CancelTaskResult", reply.body.result).valid).toBe(true);
    });

    it("lets a cancelled task still finish, as cooperative cancellation allows", async () => {
      const created = (await rpc("tools/call", work(5))).body.result;
      await rpc("tasks/cancel", { taskId: created.taskId });
      await Bun.sleep(30);
      expect((await rpc("tasks/get", { taskId: created.taskId })).body.result.status).toBe("completed");
    });
  });

  describe("errors", () => {
    it.each(["tasks/get", "tasks/update", "tasks/cancel"])("%s answers an unknown task with -32602", async (method) => {
      const reply = await rpc(method, { taskId: "task_bm9wZQ" });
      expect(reply.body.error.code).toBe(-32602);
    });

    it.each(["tasks/get", "tasks/update", "tasks/cancel"])("%s needs the extension: -32021 and HTTP 400", async (method) => {
      const created = (await rpc("tools/call", work(1))).body.result;
      const reply = await rpc(method, { taskId: created.taskId }, { tasks: false });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32021);
    });

    it("requires Mcp-Name to carry the task id", async () => {
      const created = (await rpc("tools/call", work(1))).body.result;
      const reply = await rpc("tasks/get", { taskId: created.taskId }, { name: "something-else" });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe(-32020);
    });
  });

  describe("task notifications on subscriptions/listen", () => {
    it("reports a subscribed task once it finishes", async () => {
      const created = (await rpc("tools/call", work(20))).body.result;
      const controller = new AbortController();
      const res = await fetch(`${running.origin}/2026-07-28/mcp`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "subscriptions/listen",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "subscriptions/listen",
          params: {
            notifications: { taskIds: [created.taskId, "task_bm9wZQ"] },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": { extensions: { [EXT]: {} } },
            },
          },
        }),
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("notifications/tasks")) text += decoder.decode((await reader.read()).value);
      controller.abort();
      const messages = text
        .split("\n\n")
        .filter((block) => block.startsWith("event:"))
        .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))?.slice(6) as string));
      // The unknown task id is left out of the acknowledgment.
      expect(messages[0].params.notifications).toEqual({ taskIds: [created.taskId] });
      const notification = messages.find((message) => message.method === "notifications/tasks");
      expect(notification.params).toMatchObject({
        _meta: { "io.modelcontextprotocol/subscriptionId": 5 },
        taskId: created.taskId,
        status: "completed",
        result: { structuredContent: { steps: 2, completed: true } },
      });
      expect(validateTasksExtension("TaskStatusNotification", notification)).toEqual({ valid: true, errors: [] });
    });

    it("refuses task notifications to a client without the extension", async () => {
      const res = await fetch(`${running.origin}/2026-07-28/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "subscriptions/listen",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "subscriptions/listen",
          params: {
            notifications: { taskIds: ["task_x"] },
            _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
          },
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32021);
    });
  });
});
