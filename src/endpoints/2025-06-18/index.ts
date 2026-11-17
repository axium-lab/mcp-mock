import { legacyRouter } from "../2025-11-25/index.ts";
import type { LegacyProfile } from "../2025-11-25/profile.ts";
import type { Endpoint } from "../types.ts";

// 2025-06-18 serves the same transport, lifecycle and catalog as 2025-11-25;
// structured output, resource links and titles all arrived in this revision.
// What differs is stated here and nowhere else.
export const PROFILE_2025_06_18: LegacyProfile = {
  revision: "2025-06-18",
  // Its tools page lists "invalid arguments" among protocol errors; SEP-1303
  // moved them to tool execution errors only in 2025-11-25.
  invalidArguments: "protocol-error",
  // Its schema requires an id on every error response.
  unreadableId: "null",
  // This revision removed batching.
  batching: false,
};

export const endpoint20250618: Endpoint = {
  name: PROFILE_2025_06_18.revision,
  mountPath: `/${PROFILE_2025_06_18.revision}`,
  revisions: ["2025-06-18"],
  createRouter: () => legacyRouter([PROFILE_2025_06_18]),
};
