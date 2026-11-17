import { withControl } from "../../core/control.ts";
import type { Handlers } from "../../core/jsonrpc.ts";
import { SERVER_INFO } from "../../core/server-info.ts";
import { callTool, checkNoCursor, listTools } from "../../tools/index.ts";
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
        capabilities: { tools: {} },
        ...CACHE_HINTS,
      }),

    "tools/list": (params) => {
      checkNoCursor(params);
      return complete({ tools: listTools(), ...CACHE_HINTS });
    },

    "tools/call": (params) => complete(callTool(params)),
  },
});
