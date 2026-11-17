import { endpoint20250326 } from "./2025-03-26/index.ts";
import { endpoint20250618 } from "./2025-06-18/index.ts";
import { endpoint20251125 } from "./2025-11-25/index.ts";
import { endpoint20260728 } from "./2026-07-28/index.ts";
import { dualEraEndpoint } from "./dual-era/index.ts";
import type { Endpoint } from "./types.ts";

// Mount order matters only for the dual-era endpoint at the root, which goes
// last so the pinned /<revision> prefixes win. Each phase adds one entry.
export const endpoints: readonly Endpoint[] = [
  endpoint20260728,
  endpoint20251125,
  endpoint20250618,
  endpoint20250326,
  dualEraEndpoint,
];
