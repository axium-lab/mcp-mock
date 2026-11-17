import { errorResponse, type JsonRpcErrorResponse, type JsonRpcId } from "../../core/jsonrpc.ts";

// Error codes 2026-07-28 allocates from the -32020..-32099 range it reserves
// for the specification. Older revisions used other numbers for some of these
// (-32001, -32003, -32004 in drafts), so they live with this revision.
export const McpErrorCode = {
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
} as const;

// -32000 is not an MCP code: it is what the official SDK server answers
// transport-level refusals (wrong HTTP method, media types) with, so clients
// see the same error body from the mock.
export const TRANSPORT_ERROR_CODE = -32000;

// A request refused before it reaches a method handler, with the HTTP status
// the spec ties to the refusal. Errors a handler produces are not rejections:
// they travel in-band with HTTP 200.
export interface Rejection {
  status: number;
  body: JsonRpcErrorResponse;
}

export function reject(
  status: number,
  id: JsonRpcId | undefined,
  code: number,
  message: string,
  data?: unknown,
): Rejection {
  return { status, body: errorResponse(id, code, message, data) };
}

export function headerMismatch(id: JsonRpcId | undefined, message: string): Rejection {
  return reject(400, id, McpErrorCode.HeaderMismatch, `Header mismatch: ${message}`);
}

export function unsupportedVersion(
  id: JsonRpcId | undefined,
  supported: readonly string[],
  requested: string | undefined,
): Rejection {
  // `requested` is left out rather than invented when the request named no
  // version at all (a legacy client without the header).
  const data =
    requested === undefined ? { supported: [...supported] } : { supported: [...supported], requested };
  return reject(400, id, McpErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version", data);
}
