import { withControl } from "../../core/control.ts";
import { ErrorCode, type Handlers } from "../../core/jsonrpc.ts";
import { SERVER_INFO } from "../../core/server-info.ts";
import { getPrompt, listPrompts } from "../../prompts/index.ts";
import { listResources, listResourceTemplates, readResource } from "../../resources/index.ts";
import { callTool, checkNoCursor, listTools } from "../../tools/index.ts";
import { isInputRequired } from "../../tools/types.ts";
import { META } from "./envelope.ts";

export const REVISION = "2026-07-28";

// Cache hints are mandatory on server/discover and list results. The catalog
// only changes with a new mcp-mock release and is the same for every caller,
// hence a long, public TTL.
const CACHE_HINTS = { ttlMs: 3_600_000, cacheScope: "public" } as const;

export interface RequestContext {
  protocolVersion: string;
}

// Every result is a "complete" one (no MRTR yet) and names the server in its
// _meta, which the spec recommends since there is no handshake to do it once.
function complete(result: object): Record<string, unknown> {
  return { ...result, resultType: "complete", _meta: { [META.serverInfo]: SERVER_INFO } };
}

// withControl lets a request force a JSON-RPC error from the test.
export const handlers: Handlers<RequestContext> = withControl({
  requests: {
    "server/discover": () =>
      complete({
        supportedVersions: [REVISION],
        capabilities: { tools: {}, resources: {}, prompts: {} },
        ...CACHE_HINTS,
      }),

    "resources/list": (params) => {
      checkNoCursor(params);
      return complete({ resources: listResources(), ...CACHE_HINTS });
    },

    "resources/templates/list": (params) => {
      checkNoCursor(params);
      return complete({ resourceTemplates: listResourceTemplates(), ...CACHE_HINTS });
    },

    // resources/read is cacheable too. A missing resource is -32602 (Invalid
    // Params) since this revision, no longer -32002.
    "resources/read": (params) => complete({ ...readResource(params, ErrorCode.InvalidParams), ...CACHE_HINTS }),

    "prompts/list": (params) => {
      checkNoCursor(params);
      return complete({ prompts: listPrompts(), ...CACHE_HINTS });
    },

    // prompts/get depends on its arguments and is not among the cacheable
    // results.
    "prompts/get": (params) => complete(getPrompt(params)),

    "tools/list": (params) => {
      checkNoCursor(params);
      return complete({ tools: listTools(), ...CACHE_HINTS });
    },

    // tools/call may answer input_required (MRTR): the tool asks the client
    // for input and the client retries with its answers. Such an interim
    // result is not "complete" and carries no cache hints.
    "tools/call": (params) => {
      const meta = (params?._meta ?? {}) as Record<string, unknown>;
      const result = callTool(params, {
        mrtr: {
          clientCapabilities: (meta[META.clientCapabilities] ?? {}) as Record<string, unknown>,
          ...(params?.inputResponses !== undefined && {
            inputResponses: params.inputResponses as Record<string, unknown>,
          }),
          ...(typeof params?.requestState === "string" && { requestState: params.requestState }),
        },
      });
      if (isInputRequired(result)) {
        return { ...result, _meta: { [META.serverInfo]: SERVER_INFO } };
      }
      return complete(result);
    },
  },
});
