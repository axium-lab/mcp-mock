// The standard request headers 2026-07-28 mirrors from the body so
// intermediaries can route without parsing it. Pure functions: the router
// reads the raw header values and hands them in.

export interface StandardHeaders {
  protocolVersion?: string;
  method?: string;
  name?: string;
}

// Methods whose Mcp-Name header mirrors a body field: the core ones, and the
// tasks extension's, whose binding asks for the task id so intermediaries can
// route every request for a task to the same place.
const NAME_SOURCE: Readonly<Record<string, string>> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
  "tasks/get": "taskId",
  "tasks/update": "taskId",
  "tasks/cancel": "taskId",
};

export function nameSource(
  method: string,
  params: Record<string, unknown> | undefined,
): { field: string; value: string | undefined } | undefined {
  if (!Object.hasOwn(NAME_SOURCE, method)) return undefined;
  const field = NAME_SOURCE[method] as string;
  const value = params?.[field];
  return { field, value: typeof value === "string" ? value : undefined };
}

// RFC 9110 optional whitespace around a field value is not part of it.
export function stripOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

const SENTINEL = /^=\?base64\?(.*)\?=$/s;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

// Values that are not plain header-safe ASCII travel as `=?base64?...?=`
// (UTF-8, Base64). Returns undefined for a malformed sentinel or invalid
// UTF-8 bytes, which the server must reject rather than compare.
export function decodeHeaderValue(value: string): string | undefined {
  const match = SENTINEL.exec(value);
  if (!match) return value;
  const encoded = match[1] as string;
  if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) return undefined;
  try {
    return UTF8.decode(Buffer.from(encoded, "base64"));
  } catch {
    return undefined;
  }
}
