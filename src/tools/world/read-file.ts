import { seeded } from "../hash.ts";
import { type Tool, toolError } from "../types.ts";
import { FIRST_NAMES, LOOKUP, RESERVED, WORDS } from "./data.ts";

const MIME_TYPES: Record<string, string> = {
  json: "application/json",
  md: "text/markdown",
  csv: "text/csv",
  txt: "text/plain",
};

function contents(extension: string, path: string): string {
  const random = seeded("read_file", path);
  const name = path.split("/").pop() as string;
  switch (extension) {
    case "json":
      return `${JSON.stringify(
        { name, version: `${random.int(0, 9)}.${random.int(0, 20)}.${random.int(0, 50)}`, enabled: random.next() < 0.5, items: random.int(1, 100) },
        null,
        2,
      )}\n`;
    case "md":
      return `# ${name}\n\nA ${random.pick(WORDS)} with ${random.int(2, 9)} sections.\n\n- ${random.pick(WORDS)}\n- ${random.pick(WORDS)}\n`;
    case "csv": {
      const rows = Array.from({ length: random.int(2, 5) }, (_, index) => `${index + 1},${random.pick(FIRST_NAMES)},${random.int(1, 1000)}`);
      return `id,name,score\n${rows.join("\n")}\n`;
    }
    default:
      return `${Array.from({ length: random.int(1, 4) }, () => `This ${random.pick(WORDS)} line ${random.int(1, 99)}.`).join("\n")}\n`;
  }
}

export type FakeFile =
  | { ok: true; path: string; uri: string; mimeType: string; text: string }
  | { ok: false; reason: "outside-root" | "not-found"; path: string };

// The fake file system, shared by the read_file tool and the file:// resources.
// Same path, same contents, whichever way it is read.
export function readFakeFile(path: string): FakeFile {
  const value = path.trim();
  if (value.split("/").includes("..")) return { ok: false, reason: "outside-root", path: value };
  const absolute = value.startsWith("/") ? value : `/${value}`;
  if (absolute === RESERVED.filePath) return { ok: false, reason: "not-found", path: absolute };

  const extension = absolute.includes(".") ? (absolute.split(".").pop() as string).toLowerCase() : "";
  return {
    ok: true,
    path: absolute,
    uri: `file://${absolute}`,
    mimeType: MIME_TYPES[extension] ?? "text/plain",
    text: contents(extension, absolute),
  };
}

// Returns the file as an embedded resource, the content type for handing over
// the thing itself rather than a link to it.
export const readFile: Tool = {
  definition: {
    name: "read_file",
    title: "Read file",
    description: `Reads a text file from a fake file system. Contents are stable and follow the extension (.json, .md, .csv, anything else as plain text). Paths with ".." are refused, and "${RESERVED.filePath}" does not exist.`,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, description: "Absolute path of the file." } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: LOOKUP,
  },
  run: ({ path }) => {
    const file = readFakeFile(path as string);
    if (!file.ok) {
      return toolError(
        file.reason === "outside-root"
          ? `Access denied: "${file.path}" leaves the root directory`
          : `File not found: ${file.path}`,
      );
    }
    return {
      content: [{ type: "resource", resource: { uri: file.uri, mimeType: file.mimeType, text: file.text } }],
    };
  },
};
