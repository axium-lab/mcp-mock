import { ErrorCode, type Handlers, JsonRpcError } from "./jsonrpc.ts";

// Stateless control from the test: each request carries what its own answer
// must be, so identical requests always get identical answers, with no
// registration beforehand and nothing shared between requests or replicas.
//
// - _meta["com.mcp-mock/response"] replaces the result of a tools/call.
// - _meta["com.mcp-mock/error"] makes any request fail with a JSON-RPC error.
// - The x-mcp-mock-status header forces an HTTP failure (see forcedStatus).
//
// _meta travels in every revision and on every transport, and the official
// SDKs let a test set it per call. The prefix is mcp-mock.com in reverse DNS,
// as the spec asks of non-MCP _meta keys.

export const CONTROL = {
  response: "com.mcp-mock/response",
  error: "com.mcp-mock/error",
  inputRequired: "com.mcp-mock/input-required",
  statusHeader: "x-mcp-mock-status",
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function controlOf(params: Record<string, unknown> | undefined, key: string): unknown {
  const meta = params?._meta;
  return isObject(meta) ? meta[key] : undefined;
}

function invalid(key: string, problem: string): JsonRpcError {
  return new JsonRpcError(ErrorCode.InvalidParams, `Invalid params: _meta ${key}: ${problem}`);
}

export interface ForcedResult {
  content: Record<string, unknown>[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// The forced tools/call result, or undefined when the request forces none.
// `text` is shorthand for one text block; structured content without content
// gets its JSON as a text block, as the spec asks of tools that return
// structured content. Content blocks are passed through as given, so a test
// can also send ones its client should reject.
export function forcedResult(params: Record<string, unknown> | undefined): ForcedResult | undefined {
  const value = controlOf(params, CONTROL.response);
  if (value === undefined) return undefined;
  const key = CONTROL.response;
  if (!isObject(value)) throw invalid(key, "expected an object");

  const { text, content, structuredContent, isError } = value;
  const unknown = Object.keys(value).filter(
    (field) => !["text", "content", "structuredContent", "isError"].includes(field),
  );
  if (unknown.length > 0) throw invalid(key, `unknown field(s): ${unknown.join(", ")}`);
  if (text !== undefined && typeof text !== "string") throw invalid(key, '"text" must be a string');
  if (text !== undefined && content !== undefined) throw invalid(key, 'use either "text" or "content", not both');
  if (content !== undefined && (!Array.isArray(content) || !content.every((block) => isObject(block) && typeof block.type === "string"))) {
    throw invalid(key, '"content" must be an array of content blocks, each with a string "type"');
  }
  if (structuredContent !== undefined && !isObject(structuredContent)) {
    throw invalid(key, '"structuredContent" must be an object');
  }
  if (isError !== undefined && typeof isError !== "boolean") throw invalid(key, '"isError" must be a boolean');
  if (text === undefined && content === undefined && structuredContent === undefined) {
    throw invalid(key, 'give at least one of "text", "content" or "structuredContent"');
  }

  const blocks =
    text !== undefined
      ? [{ type: "text", text }]
      : content !== undefined
        ? (content as Record<string, unknown>[])
        : [{ type: "text", text: JSON.stringify(structuredContent) }];
  return {
    content: blocks,
    ...(structuredContent !== undefined && { structuredContent: structuredContent as Record<string, unknown> }),
    ...(isError !== undefined && { isError: isError as boolean }),
  };
}

export interface ForcedInputRequired {
  inputRequests?: Record<string, Record<string, unknown>>;
  requestState?: string;
}

// The input_required answer a tools/call forces (2026-07-28 only), or
// undefined when it forces none. Its input requests are passed through as
// given, even for capabilities the client did not declare, so a test can
// check how its client copes.
export function forcedInputRequired(
  params: Record<string, unknown> | undefined,
): ForcedInputRequired | undefined {
  const value = controlOf(params, CONTROL.inputRequired);
  if (value === undefined) return undefined;
  const key = CONTROL.inputRequired;
  if (!isObject(value)) throw invalid(key, "expected an object");

  const { inputRequests, requestState } = value;
  const unknown = Object.keys(value).filter((field) => !["inputRequests", "requestState"].includes(field));
  if (unknown.length > 0) throw invalid(key, `unknown field(s): ${unknown.join(", ")}`);
  if (
    inputRequests !== undefined &&
    (!isObject(inputRequests) ||
      !Object.values(inputRequests).every((request) => isObject(request) && typeof request.method === "string"))
  ) {
    throw invalid(key, '"inputRequests" must map ids to requests, each with a string "method"');
  }
  if (requestState !== undefined && typeof requestState !== "string") {
    throw invalid(key, '"requestState" must be a string');
  }
  if (inputRequests === undefined && requestState === undefined) {
    throw invalid(key, 'give at least one of "inputRequests" or "requestState", as the spec requires');
  }
  return {
    ...(inputRequests !== undefined && { inputRequests: inputRequests as Record<string, Record<string, unknown>> }),
    ...(requestState !== undefined && { requestState: requestState as string }),
  };
}

// Throws the JSON-RPC error a request forces, if any.
function throwForcedError(params: Record<string, unknown> | undefined): void {
  const value = controlOf(params, CONTROL.error);
  if (value === undefined) return;
  const key = CONTROL.error;
  if (!isObject(value)) throw invalid(key, "expected an object");
  if (!Number.isInteger(value.code)) throw invalid(key, '"code" must be an integer');
  if (typeof value.message !== "string") throw invalid(key, '"message" must be a string');
  throw new JsonRpcError(value.code as number, value.message, value.data);
}

// Wraps every request handler so a forced error wins over the method's own
// answer. Notifications are left alone: JSON-RPC forbids answering them.
export function withControl<Context>(handlers: Handlers<Context>): Handlers<Context> {
  const requests = Object.fromEntries(
    Object.entries(handlers.requests).map(([method, handler]) => [
      method,
      (params: Record<string, unknown> | undefined, context: Context) => {
        throwForcedError(params);
        return handler(params, context);
      },
    ]),
  );
  return { ...handlers, requests };
}

export interface ForcedStatus {
  status: number;
  message: string;
  // Extra response headers, e.g. Retry-After on 429.
  headers: Record<string, string>;
}

function defaultMessage(status: number): string {
  switch (status) {
    case 429:
      return "Too Many Requests: rate limit reached.";
    case 500:
      return "Internal Server Error.";
    case 502:
      return "Bad Gateway.";
    case 503:
      return "Service Unavailable: the server is temporarily unavailable.";
    case 504:
      return "Gateway Timeout.";
    default:
      return `Simulated HTTP ${status}, provoked via ${CONTROL.statusHeader}.`;
  }
}

// The HTTP failure the x-mcp-mock-status header forces: any status from 400
// to 599. A value outside that range is itself refused with 400, so a typo
// never passes silently as a success.
export function forcedStatus(header: string | undefined): ForcedStatus | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  const status = /^\d{3}$/.test(value) ? Number(value) : Number.NaN;
  if (!(status >= 400 && status <= 599)) {
    return {
      status: 400,
      message: `Bad Request: ${CONTROL.statusHeader} must be an HTTP error status between 400 and 599, got "${header}"`,
      headers: {},
    };
  }
  return {
    status,
    message: defaultMessage(status),
    headers: status === 429 ? { "Retry-After": "1" } : {},
  };
}
