import { structured, type Tool } from "../types.ts";
import { PURE } from "./annotations.ts";

// Sorted by UTF-16 code unit, not localeCompare: locale collation depends on
// the ICU data of the runtime, and the order must be the same everywhere.
export const sortList: Tool = {
  definition: {
    name: "sort_list",
    title: "Sort list",
    description: "Sorts a list of strings by code point, ascending unless told otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
          maxItems: 1000,
          description: "The strings to sort.",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort order. Defaults to asc.",
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
    },
    annotations: PURE,
  },
  run: ({ items, order }) => {
    const sorted = [...(items as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return structured({ items: order === "desc" ? sorted.reverse() : sorted });
  },
};
