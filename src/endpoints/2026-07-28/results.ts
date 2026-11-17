import { SERVER_INFO } from "../../core/server-info.ts";
import { META } from "./envelope.ts";

// Cache hints are mandatory on server/discover and list results. The catalog
// only changes with a new mcp-mock release and is the same for every caller,
// hence a long, public TTL.
export const CACHE_HINTS = { ttlMs: 3_600_000, cacheScope: "public" } as const;

export const SERVER_META = { [META.serverInfo]: SERVER_INFO };

// A final result: "complete", naming the server in its _meta, which the spec
// recommends since there is no handshake to do it once.
export function complete(result: object): Record<string, unknown> {
  return { ...result, resultType: "complete", _meta: SERVER_META };
}
