import type { ToolAnnotations } from "../types.ts";

// Pure computations: nothing is read from or written to the outside world,
// and the same input always gives the same output.
export const PURE: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
