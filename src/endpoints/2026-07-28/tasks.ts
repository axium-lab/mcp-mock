import { CONTROL } from "../../core/control.ts";
import { ErrorCode, JsonRpcError } from "../../core/jsonrpc.ts";
import {
  decodeTask,
  declaresTasks,
  encodeTask,
  MISSING_TASKS_CAPABILITY,
  type TaskRecord,
  taskFields,
} from "../../tasks/index.ts";
import { callTool } from "../../tools/index.ts";
import { isInputRequired, MISSING_REQUIRED_CLIENT_CAPABILITY } from "../../tools/types.ts";
import { META } from "./envelope.ts";
import { complete, SERVER_META } from "./results.ts";

// Tasks on 2026-07-28: when a tools/call becomes a task, how a task reports
// its state, and the tasks/* methods.

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clientCapabilitiesOf(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta = isObject(params?._meta) ? params._meta : {};
  const capabilities = meta[META.clientCapabilities];
  return isObject(capabilities) ? capabilities : {};
}

function requireTasks(params: Record<string, unknown> | undefined): void {
  if (!declaresTasks(clientCapabilitiesOf(params))) {
    throw new JsonRpcError(
      MISSING_REQUIRED_CLIENT_CAPABILITY,
      "Missing required client capability: the tasks extension",
      MISSING_TASKS_CAPABILITY,
    );
  }
}

// How long a tools/call would run as a task, or undefined when it should be
// answered synchronously. The server decides per request; this one makes a
// task of simulate_work, the slow tool, for clients that declare the
// extension, and of any call a test forces with _meta["com.mcp-mock/task"].
// A forced task for a client without the extension is a request the server
// cannot serve, which the extension answers with -32021.
export function taskDuration(params: Record<string, unknown> | undefined): number | undefined {
  const meta = isObject(params?._meta) ? params._meta : {};
  const forced = meta[CONTROL.task];
  const declared = declaresTasks(clientCapabilitiesOf(params));
  if (forced !== undefined) {
    const duration = isObject(forced) ? (forced.durationMs ?? 0) : undefined;
    if (!Number.isInteger(duration) || (duration as number) < 0 || (duration as number) > 600_000) {
      throw new JsonRpcError(
        ErrorCode.InvalidParams,
        `Invalid params: _meta ${CONTROL.task} must be an object with an optional integer "durationMs" from 0 to 600000`,
      );
    }
    if (!declared) requireTasks(params);
    return duration as number;
  }
  if (!declared || params?.name !== "simulate_work") return undefined;
  const args = isObject(params.arguments) ? params.arguments : {};
  const steps = Number.isInteger(args.steps) ? (args.steps as number) : 5;
  const stepMs = Number.isInteger(args.step_ms) ? (args.step_ms as number) : 100;
  return steps * stepMs;
}

// Only what replaying the call needs: the tool, its arguments, and the
// controls that decide its answer. Protocol metadata is per request.
function replayable(params: Record<string, unknown>): Record<string, unknown> {
  const meta = isObject(params._meta) ? params._meta : {};
  const controls = Object.fromEntries(
    [CONTROL.response, CONTROL.error].filter((key) => key in meta).map((key) => [key, meta[key]]),
  );
  return {
    name: params.name,
    ...(params.arguments !== undefined && { arguments: params.arguments }),
    ...(Object.keys(controls).length > 0 && { _meta: controls }),
  };
}

export function createTask(params: Record<string, unknown>, durationMs: number, now: number): Record<string, unknown> {
  const record: TaskRecord = { params: replayable(params), startedAt: now, durationMs };
  const taskId = encodeTask(record);
  return { ...taskFields(taskId, record, now), resultType: "task", _meta: SERVER_META };
}

// A task in full: its fields, and for a finished task the outcome of its
// call, which is replayed now since nothing was stored. A JSON-RPC error
// fails the task; a tool result, isError included, completes it.
export async function detailedTask(taskId: string, now: number): Promise<Record<string, unknown>> {
  const record = decodeTask(taskId);
  const fields = taskFields(taskId, record, now);
  if (fields.status !== "completed") return fields;
  try {
    const result = await callTool(record.params, { instant: true });
    if (isInputRequired(result)) throw new Error("input_required in a task replay");
    return { ...fields, result: complete(result) };
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error;
    const { statusMessage: _omitted, ...rest } = fields;
    return { ...rest, status: "failed", statusMessage: `The call failed: ${error.message}`, error: error.toObject() };
  }
}

export const taskHandlers = {
  "tasks/get": async (params: Record<string, unknown> | undefined) => {
    requireTasks(params);
    return complete(await detailedTask(params?.taskId as string, Date.now()));
  },

  // Nothing is outstanding on a task that never asks for input, and the
  // extension asks servers to ignore responses to keys they did not issue.
  "tasks/update": (params: Record<string, unknown> | undefined) => {
    requireTasks(params);
    decodeTask(params?.taskId);
    return complete({});
  },

  // Cancellation is cooperative and eventually consistent: acknowledged, and
  // the task may still finish as it would have, which the extension allows.
  // A task with no state of its own cannot be stopped.
  "tasks/cancel": (params: Record<string, unknown> | undefined) => {
    requireTasks(params);
    decodeTask(params?.taskId);
    return complete({});
  },
};
