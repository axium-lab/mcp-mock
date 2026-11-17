import { ErrorCode, JsonRpcError } from "../core/jsonrpc.ts";

// The tasks extension (io.modelcontextprotocol/tasks, 2026-07-28), without
// server-side state. The extension assumes a server that stores its tasks;
// here the task id carries everything a later tasks/get needs instead: the
// original call, when the task started and how long it runs. Any server
// instance can answer for any task, nothing is stored, nothing expires early.
//
// The one exception to the mock's determinism lives here: a task's status
// depends on how much time has passed since it started, and its timestamps
// are real. Its result, once completed, is as deterministic as the call.

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const TASK_TTL_MS = 3_600_000;
export const POLL_INTERVAL_MS = 100;
const PREFIX = "task_";

export interface TaskRecord {
  // The original tools/call params, replayed when the task completes.
  params: Record<string, unknown>;
  startedAt: number;
  durationMs: number;
}

export function declaresTasks(clientCapabilities: Record<string, unknown>): boolean {
  const extensions = clientCapabilities.extensions;
  return typeof extensions === "object" && extensions !== null && TASKS_EXTENSION in extensions;
}

export const MISSING_TASKS_CAPABILITY = {
  requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
};

export function encodeTask(record: TaskRecord): string {
  return PREFIX + Buffer.from(JSON.stringify(record)).toString("base64url");
}

// The record behind a task id. Anything that does not decode to one is an
// unknown task, which the extension answers with Invalid Params. A forged id
// can only describe a tool call the caller could make directly.
export function decodeTask(taskId: unknown): TaskRecord {
  const unknown = () => new JsonRpcError(ErrorCode.InvalidParams, `Invalid params: unknown task ${String(taskId)}`);
  if (typeof taskId !== "string" || !taskId.startsWith(PREFIX)) throw unknown();
  try {
    const record = JSON.parse(Buffer.from(taskId.slice(PREFIX.length), "base64url").toString("utf8")) as TaskRecord;
    if (
      typeof record.params !== "object" ||
      record.params === null ||
      !Number.isFinite(record.startedAt) ||
      !Number.isFinite(record.durationMs)
    ) {
      throw unknown();
    }
    return record;
  } catch {
    throw unknown();
  }
}

// The fields every task carries, whatever its status.
export function taskFields(taskId: string, record: TaskRecord, now: number) {
  const done = now >= record.startedAt + record.durationMs;
  const progress = record.durationMs === 0 ? 100 : Math.min(100, Math.floor(((now - record.startedAt) / record.durationMs) * 100));
  return {
    taskId,
    status: done ? ("completed" as const) : ("working" as const),
    ...(done ? {} : { statusMessage: `Working: ${progress}%` }),
    createdAt: new Date(record.startedAt).toISOString(),
    lastUpdatedAt: new Date(done ? record.startedAt + record.durationMs : record.startedAt).toISOString(),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}
