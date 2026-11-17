import type { Tool } from "../types.ts";
import { PURE } from "./annotations.ts";

// The smallest possible check that arguments arrive intact: unicode, emoji
// and long texts come back exactly as sent.
export const echo: Tool = {
  definition: {
    name: "echo",
    title: "Echo",
    description: 'Returns the given text prefixed with "Echo: ".',
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to echo back." } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: PURE,
  },
  run: ({ text }) => ({ content: [{ type: "text", text: `Echo: ${text as string}` }] }),
};
