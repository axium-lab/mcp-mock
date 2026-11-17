import { structured, type Tool } from "../types.ts";
import { PURE } from "./annotations.ts";

const OPERATIONS: Record<string, (text: string) => string> = {
  upper: (text) => text.toUpperCase(),
  lower: (text) => text.toLowerCase(),
  // By code point, so emoji and astral characters survive the reversal.
  reverse: (text) => Array.from(text).reverse().join(""),
  slug: (text) =>
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
};

// Exercises an enum in the input schema.
export const transformText: Tool = {
  definition: {
    name: "transform_text",
    title: "Transform text",
    description: "Converts text to upper case, lower case, reversed, or a URL slug.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to transform." },
        operation: {
          type: "string",
          enum: Object.keys(OPERATIONS),
          description: "The transformation to apply.",
        },
      },
      required: ["text", "operation"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    },
    annotations: PURE,
  },
  run: ({ text, operation }) =>
    structured({ result: (OPERATIONS[operation as string] as (text: string) => string)(text as string) }),
};
