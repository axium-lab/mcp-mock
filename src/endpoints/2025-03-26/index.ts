import { PROFILE_2025_06_18 } from "../2025-06-18/index.ts";
import { legacyRouter } from "../2025-11-25/index.ts";
import type { LegacyProfile } from "../2025-11-25/profile.ts";
import type { Endpoint } from "../types.ts";

// 2025-03-26 is 2025-06-18 with JSON-RPC batching, and without what
// 2025-06-18 added to tools: top-level titles, output schemas, structured
// content and resource links.
export const PROFILE_2025_03_26: LegacyProfile = {
  ...PROFILE_2025_06_18,
  revision: "2025-03-26",
  // Servers MUST accept batches in this revision.
  batching: true,

  // A tool had only a name, a description, an input schema and annotations.
  // The display title already existed, inside the annotations, so it moves
  // there instead of being lost.
  adaptDefinition: ({ name, title, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    annotations: { title, ...annotations },
  }),

  // A result was content and isError only. Tools with structured content
  // already repeat it as JSON in a text block, which stays; resource links
  // are dropped, and search_web's text keeps every URL they pointed at.
  adaptResult: ({ content, isError }) => ({
    content: content.filter((block) => block.type !== "resource_link"),
    ...(isError !== undefined && { isError }),
  }),
};

export const endpoint20250326: Endpoint = {
  name: PROFILE_2025_03_26.revision,
  mountPath: `/${PROFILE_2025_03_26.revision}`,
  entryPaths: ["/mcp"],
  revisions: ["2025-03-26"],
  createRouter: () => legacyRouter([PROFILE_2025_03_26]),
};
