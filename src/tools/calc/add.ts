import { structured, type Tool } from "../types.ts";
import { PURE } from "./annotations.ts";

// Typed numeric arguments. The sum is plain IEEE 754 arithmetic, so
// 0.1 + 0.2 is 0.30000000000000004, as in any real implementation.
export const add: Tool = {
  definition: {
    name: "add",
    title: "Add",
    description: "Adds two numbers.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "The first addend." },
        b: { type: "number", description: "The second addend." },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { sum: { type: "number" } },
      required: ["sum"],
    },
    annotations: PURE,
  },
  run: ({ a, b }) => structured({ sum: (a as number) + (b as number) }),
};
