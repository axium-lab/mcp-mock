import { ErrorCode, type Handlers, JsonRpcError } from "../../core/jsonrpc.ts";
import { SERVER_INFO } from "../../core/server-info.ts";
import { META } from "./envelope.ts";
import { findTool, listTools } from "./tools.ts";

export const REVISION = "2026-07-28";

// Cache hints are mandatory on server/discover and list results. The catalog
// only changes with a new mcp-mock release and is the same for every caller,
// hence a long, public TTL.
const CACHE_HINTS = { ttlMs: 3_600_000, cacheScope: "public" } as const;

export interface RequestContext {
  protocolVersion: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every result is a "complete" one (no MRTR yet) and names the server in its
// _meta, which the spec recommends since there is no handshake to do it once.
function complete(result: Record<string, unknown>): Record<string, unknown> {
  return { ...result, resultType: "complete", _meta: { [META.serverInfo]: SERVER_INFO } };
}

export const handlers: Handlers<RequestContext> = {
  requests: {
    "server/discover": () =>
      complete({
        supportedVersions: [REVISION],
        capabilities: { tools: {} },
        ...CACHE_HINTS,
      }),

    // The mock never paginates, so it never issues a cursor: any cursor a
    // client sends is one it made up.
    "tools/list": (params) => {
      if (params?.cursor !== undefined) {
        throw new JsonRpcError(ErrorCode.InvalidParams, "Invalid params: unknown cursor");
      }
      return complete({ tools: listTools(), ...CACHE_HINTS });
    },

    // Protocol errors for a request the model cannot fix (malformed params,
    // unknown tool); tool execution errors, in the result, for arguments it can.
    "tools/call": (params) => {
      const name = params?.name;
      if (typeof name !== "string") {
        throw new JsonRpcError(ErrorCode.InvalidParams, 'Invalid params: "name" must be a string');
      }
      const args = params?.arguments ?? {};
      if (!isObject(args)) {
        throw new JsonRpcError(ErrorCode.InvalidParams, 'Invalid params: "arguments" must be an object');
      }
      const tool = findTool(name);
      if (!tool) throw new JsonRpcError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);

      const problem = tool.validate(args);
      if (problem !== undefined) {
        return complete({
          content: [{ type: "text", text: `Invalid arguments for tool ${name}: ${problem}` }],
          isError: true,
        });
      }
      return complete({ ...tool.run(args) });
    },
  },
};
