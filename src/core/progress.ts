import type { JsonRpcId, JsonRpcNotification } from "./jsonrpc.ts";

// Progress notifications, the same in every revision except for `message`,
// which arrived in 2025-03-26.

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

// The token a request asked for progress with, or undefined: a string or an
// integer under _meta.progressToken, in every revision.
export function progressTokenOf(params: Record<string, unknown> | undefined): JsonRpcId | undefined {
  const meta = params?._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const token = (meta as Record<string, unknown>).progressToken;
  return typeof token === "string" || (typeof token === "number" && Number.isInteger(token)) ? token : undefined;
}

export function progressNotification(
  progressToken: JsonRpcId,
  update: ProgressUpdate,
  withMessage: boolean,
): JsonRpcNotification {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: {
      progressToken,
      progress: update.progress,
      ...(update.total !== undefined && { total: update.total }),
      ...(withMessage && update.message !== undefined && { message: update.message }),
    },
  };
}
