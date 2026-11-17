import { ErrorCode, type Handlers, JsonRpcError } from "../../core/jsonrpc.ts";
import { SERVER_INFO } from "../../core/server-info.ts";
import { callTool, checkNoCursor, listTools } from "../2026-07-28/tools.ts";

export const REVISION = "2025-11-25";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Results are plain objects: resultType, cache hints and serverInfo in _meta
// only arrived with 2026-07-28. The tools themselves are 2026-07-28's, whose
// results this revision already understands as they are.
export const handlers: Handlers<Record<string, never>> = {
  requests: {
    // Version negotiation: a server answers with the requested version when
    // it supports it, and otherwise with one it does support, never with an
    // error. This endpoint is pinned, so it always answers with its own and
    // leaves it to the client to disconnect if that does not suit it.
    initialize: (params) => {
      if (
        typeof params?.protocolVersion !== "string" ||
        !isObject(params.capabilities) ||
        !isObject(params.clientInfo)
      ) {
        throw new JsonRpcError(
          ErrorCode.InvalidParams,
          'Invalid params: initialize requires "protocolVersion", "capabilities" and "clientInfo"',
        );
      }
      return {
        protocolVersion: REVISION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    },

    ping: () => ({}),

    "tools/list": (params) => {
      checkNoCursor(params);
      return { tools: listTools() };
    },

    "tools/call": (params) => ({ ...callTool(params) }),
  },
};
