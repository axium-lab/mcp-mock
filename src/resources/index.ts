import { createHash } from "node:crypto";
import { ErrorCode, JsonRpcError } from "../core/jsonrpc.ts";
import { solidPng } from "../tools/png.ts";
import { getUser } from "../tools/world/people.ts";
import { readFakeFile } from "../tools/world/read-file.ts";
import { getWeather } from "../tools/world/weather.ts";

// The resource catalog, independent of any revision. Contents come from the
// same deterministic fake world as the tools: file:// is read_file's file
// system, weather:// is get_weather, user:// is get_user. The same URI always
// reads the same bytes.

export interface ResourceDefinition {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  size: number;
}

export interface ResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType?: string;
}

export type ResourceContents =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string };

// A logo whose colour comes from the hash of its path: a binary resource,
// read as a base64 blob.
function png(path: string): ResourceContents {
  const digest = createHash("sha256").update(path).digest();
  const color = [digest[0], digest[1], digest[2]] as [number, number, number];
  return { uri: `file://${path}`, mimeType: "image/png", blob: solidPng(16, color).toString("base64") };
}

class NotFound extends Error {}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new NotFound();
  }
}

// Every URI this mock can read, or NotFound. Unknown schemes, reserved values
// and paths outside the root are all "not found": a resource either exists or
// it does not.
function contentsOf(uri: string): ResourceContents {
  const file = /^file:\/\/(\/.*)$/.exec(uri);
  if (file) {
    const path = file[1] as string;
    if (path.toLowerCase().endsWith(".png")) {
      if (path.split("/").includes("..")) throw new NotFound();
      return png(path);
    }
    const read = readFakeFile(path);
    if (!read.ok) throw new NotFound();
    return { uri, mimeType: read.mimeType, text: read.text };
  }

  const weather = /^weather:\/\/(.+)$/.exec(uri);
  if (weather) {
    const result = getWeather.run({ city: decodeSegment(weather[1] as string) }, {});
    if ("isError" in result && result.isError) throw new NotFound();
    return { uri, mimeType: "application/json", text: JSON.stringify((result as { structuredContent: unknown }).structuredContent) };
  }

  const user = /^user:\/\/(.+)$/.exec(uri);
  if (user) {
    const result = getUser.run({ user_id: decodeSegment(user[1] as string) }, {});
    if ("isError" in result && result.isError) throw new NotFound();
    return { uri, mimeType: "application/json", text: JSON.stringify((result as { structuredContent: unknown }).structuredContent) };
  }

  throw new NotFound();
}

const STATIC: readonly Omit<ResourceDefinition, "size">[] = [
  {
    uri: "file:///etc/app/config.json",
    name: "config.json",
    title: "Application configuration",
    description: "The application's configuration file.",
    mimeType: "application/json",
  },
  {
    uri: "file:///docs/README.md",
    name: "README.md",
    title: "Project README",
    description: "The project's README.",
    mimeType: "text/markdown",
  },
  {
    uri: "file:///data/report.csv",
    name: "report.csv",
    title: "Score report",
    description: "A small CSV report of scores.",
    mimeType: "text/csv",
  },
  {
    uri: "file:///images/logo.png",
    name: "logo.png",
    title: "Logo",
    description: "A 16x16 PNG logo, read as a base64 blob.",
    mimeType: "image/png",
  },
];

function sizeOf(contents: ResourceContents): number {
  return "text" in contents ? Buffer.byteLength(contents.text, "utf8") : Buffer.from(contents.blob, "base64").length;
}

// Listing order is fixed, as the spec asks for list results.
export function listResources(): ResourceDefinition[] {
  return STATIC.map((resource) => ({ ...resource, size: sizeOf(contentsOf(resource.uri)) }));
}

export function listResourceTemplates(): ResourceTemplateDefinition[] {
  return [
    {
      uriTemplate: "weather://{city}",
      name: "weather",
      title: "Current weather",
      description: 'The current weather of a city, as get_weather reports it. "weather://Atlantis" does not exist.',
      mimeType: "application/json",
    },
    {
      uriTemplate: "user://{user_id}",
      name: "user",
      title: "User profile",
      description: 'A user profile, as get_user reports it. "user://missing" does not exist.',
      mimeType: "application/json",
    },
    {
      uriTemplate: "file:///{path}",
      name: "file",
      title: "File",
      description: 'Any file of the fake file system read_file serves. "file:///missing" does not exist.',
    },
  ];
}

// resources/read. A missing resource is answered with the given code, which
// changed between revisions: -32002 until 2025-11-25, -32602 from 2026-07-28.
export function readResource(
  params: Record<string, unknown> | undefined,
  notFoundCode: number,
): { contents: ResourceContents[] } {
  const uri = params?.uri;
  if (typeof uri !== "string" || uri.length === 0) {
    throw new JsonRpcError(ErrorCode.InvalidParams, 'Invalid params: "uri" must be a non-empty string');
  }
  try {
    return { contents: [contentsOf(uri)] };
  } catch (error) {
    if (error instanceof NotFound) throw new JsonRpcError(notFoundCode, "Resource not found", { uri });
    throw error;
  }
}
