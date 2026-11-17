import type { JsonRpcErrorResponse } from "../../core/jsonrpc.ts";
import type { ToolDefinition, ToolResult } from "../../tools/types.ts";

// What sets one legacy revision apart from another on the wire. The legacy
// server is shared; each legacy revision is a profile, and an older revision
// only states how it differs from 2025-11-25.
export interface LegacyProfile {
  revision: string;
  // Arguments that break a tool's input schema: a tool execution error since
  // 2025-11-25 (SEP-1303), a JSON-RPC protocol error before it.
  invalidArguments: "tool-error" | "protocol-error";
  // An error whose request id cannot be read: 2025-11-25 and later omit the
  // id; earlier schemas require one and have no valid form for it, so these
  // revisions send `id: null`, as JSON-RPC 2.0 and the official SDK server do.
  unreadableId: "omit" | "null";
  // Whether a POST body may be a JSON-RPC batch: only in 2025-03-26, which
  // required servers to accept them; 2025-06-18 removed them.
  batching: boolean;
  // Whether resources, resource templates, prompts and prompt arguments have
  // a display `title`, which arrived in 2025-06-18.
  titles: boolean;
  // The catalog in this revision's vocabulary, for revisions that predate
  // parts of it. Omitted when the catalog is served as it is.
  adaptDefinition?: (definition: ToolDefinition) => Record<string, unknown>;
  adaptResult?: (result: ToolResult) => Record<string, unknown>;
}

export const PROFILE_2025_11_25: LegacyProfile = {
  revision: "2025-11-25",
  invalidArguments: "tool-error",
  unreadableId: "omit",
  batching: false,
  titles: true,
};

export function shapeFor(profile: LegacyProfile) {
  return (body: JsonRpcErrorResponse): JsonRpcErrorResponse =>
    profile.unreadableId === "null" && !("id" in body)
      ? { jsonrpc: "2.0", id: null, error: body.error }
      : body;
}
