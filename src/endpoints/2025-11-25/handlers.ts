import { ErrorCode, type Handlers, JsonRpcError } from "../../core/jsonrpc.ts";
import { SERVER_INFO } from "../../core/server-info.ts";
import { callTool, checkNoCursor, listTools } from "../../tools/index.ts";
import type { LegacyProfile } from "./profile.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The methods of a legacy revision. Results are plain objects: resultType,
// cache hints and serverInfo in _meta only arrived with 2026-07-28.
export function legacyHandlers(profile: LegacyProfile): Handlers<Record<string, never>> {
  const adaptDefinition = profile.adaptDefinition ?? ((definition) => ({ ...definition }));
  const adaptResult = profile.adaptResult ?? ((result) => ({ ...result }));

  return {
    requests: {
      // The profile was chosen from the requested version (or as the newest
      // served when that one is not), so answering with its revision is the
      // spec's negotiation: the requested version when supported, another
      // supported one otherwise, never an error. A client that cannot use the
      // answer disconnects.
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
          protocolVersion: profile.revision,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
      },

      ping: () => ({}),

      "tools/list": (params) => {
        checkNoCursor(params);
        return { tools: listTools().map(adaptDefinition) };
      },

      "tools/call": (params) =>
        adaptResult(callTool(params, { invalidArguments: profile.invalidArguments })),
    },
  };
}
