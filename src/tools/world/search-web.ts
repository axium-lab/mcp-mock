import { normalizeText, seeded, titleCase } from "../hash.ts";
import type { ContentBlock, Tool } from "../types.ts";
import { toolError } from "../types.ts";
import { LOOKUP, RESERVED, WORDS } from "./data.ts";

function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Results come back both as structured data and as resource_link blocks, the
// content type for pointing at something rather than embedding it.
export const searchWeb: Tool = {
  definition: {
    name: "search_web",
    title: "Web search",
    description: `Searches the web. Results are fake but stable, all under example.com. The query "${RESERVED.searchQuery}" makes the search backend fail.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "What to search for." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of results. Defaults to 5.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
            },
            required: ["title", "url", "snippet"],
          },
        },
      },
      required: ["query", "results"],
    },
    annotations: LOOKUP,
  },
  run: ({ query, limit }) => {
    const key = normalizeText(query as string);
    if (key === RESERVED.searchQuery) return toolError("Search failed: the search backend is unavailable");

    const random = seeded("search_web", key);
    const topic = titleCase(key);
    const slug = slugify(key) || "results";
    // Ten results are always drawn, so a smaller limit returns a prefix of a
    // larger one.
    const all = Array.from({ length: 10 }, (_, index) => {
      const word = random.pick(WORDS);
      return {
        title: `${topic}: ${titleCase(word)}`,
        url: `https://example.com/${slug}/${index + 1}-${word}`,
        snippet: `A ${word} about ${key}, with ${random.int(2, 12)} sections and ${random.int(1, 40)} examples.`,
      };
    });
    const results = all.slice(0, (limit as number | undefined) ?? 5);

    const data = { query: key, results };
    const links: ContentBlock[] = results.map((result) => ({
      type: "resource_link",
      uri: result.url,
      name: result.title,
      description: result.snippet,
      mimeType: "text/html",
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(data) }, ...links],
      structuredContent: data,
    };
  },
};
