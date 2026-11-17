import { structured, type Tool } from "../types.ts";
import { PURE } from "./annotations.ts";

export const textStats: Tool = {
  definition: {
    name: "text_stats",
    title: "Text statistics",
    description: "Counts the words, characters and lines of a text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to measure." } },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        words: { type: "integer" },
        chars: { type: "integer", description: "Unicode code points, not UTF-16 units." },
        lines: { type: "integer" },
      },
      required: ["words", "chars", "lines"],
    },
    annotations: PURE,
  },
  run: ({ text }) => {
    const value = text as string;
    return structured({
      words: value.split(/\s+/).filter(Boolean).length,
      chars: Array.from(value).length,
      lines: value === "" ? 0 : value.split(/\r\n|\r|\n/).length,
    });
  },
};
