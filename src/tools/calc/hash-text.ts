import { createHash } from "node:crypto";
import { structured, type Tool } from "../types.ts";
import { PURE } from "./annotations.ts";

// An exact output a test can verify independently.
export const hashText: Tool = {
  definition: {
    name: "hash_text",
    title: "Hash text",
    description: "Computes the hex digest of a UTF-8 text with MD5, SHA-1 or SHA-256.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to hash." },
        algorithm: {
          type: "string",
          enum: ["md5", "sha1", "sha256"],
          description: "The hash algorithm.",
        },
      },
      required: ["text", "algorithm"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { algorithm: { type: "string" }, hex: { type: "string" } },
      required: ["algorithm", "hex"],
    },
    annotations: PURE,
  },
  run: ({ text, algorithm }) =>
    structured({
      algorithm: algorithm as string,
      hex: createHash(algorithm as string)
        .update(text as string, "utf8")
        .digest("hex"),
    }),
};
