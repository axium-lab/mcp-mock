import type { Endpoint } from "./types.ts";

// Mount order matters only for the dual-era endpoint at the root, which goes
// last so the pinned /<revision> prefixes win. Each phase adds one entry.
export const endpoints: readonly Endpoint[] = [];
