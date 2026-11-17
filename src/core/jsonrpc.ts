// Transport-agnostic JSON-RPC 2.0, the wire format under every MCP revision.
// Nothing here knows about HTTP or about a particular spec revision: endpoints
// decide how messages arrive (a POST body, an SSE stream, stdin) and which
// methods exist, and hand single messages to parseMessage and dispatch.
//
// Batches are deliberately not handled here: only 2025-03-26 allows them, so
// unwrapping an array is that revision's decision, not the core's.

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  // Only null when the request id could not be read at all (parse errors,
  // malformed envelopes), as JSON-RPC 2.0 prescribes.
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// Standard JSON-RPC 2.0 codes. MCP-specific codes (the -32020..-32099 range
// reserved by 2026-07-28, or the older -32002) belong to the revisions that
// define them.
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

// Thrown by method handlers to answer with a specific JSON-RPC error rather
// than a generic internal one.
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }

  toObject(): JsonRpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export type ParsedMessage =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  // A client answering a server-initiated request (legacy sampling,
  // elicitation, roots). Kept as-is; the endpoint correlates it.
  | { kind: "response"; message: JsonRpcResponse }
  | { kind: "invalid"; response: JsonRpcErrorResponse };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// MCP narrows JSON-RPC here: a request id must be a string or a number, never
// null, and a fractional number is not a usable id either.
function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: new JsonRpcError(code, message, data).toObject() };
}

export function successResponse(
  id: JsonRpcId,
  result: Record<string, unknown>,
): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

// Parses raw JSON text. A syntax error is the one failure that leaves no id to
// answer to, hence its null id.
export function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; response: JsonRpcErrorResponse } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: errorResponse(null, ErrorCode.ParseError, "Parse error") };
  }
}

// Classifies one already-decoded JSON value. Never throws: anything that is
// not a well-formed message comes back as an Invalid Request response, echoing
// the id when one could be read.
export function parseMessage(value: unknown): ParsedMessage {
  const invalid = (reason: string, id: JsonRpcId | null = null): ParsedMessage => ({
    kind: "invalid",
    response: errorResponse(id, ErrorCode.InvalidRequest, `Invalid Request: ${reason}`),
  });

  if (!isObject(value)) return invalid("expected a JSON object");

  const id = isId(value.id) ? value.id : null;
  if (value.jsonrpc !== "2.0") return invalid('"jsonrpc" must be "2.0"', id);

  const hasId = "id" in value;
  if (hasId && !isId(value.id)) return invalid('"id" must be a string or an integer');

  if ("method" in value) {
    if (typeof value.method !== "string") return invalid('"method" must be a string', id);
    if ("params" in value && !isObject(value.params)) {
      return invalid('"params" must be an object', id);
    }
    const params = value.params as Record<string, unknown> | undefined;
    const base = params === undefined ? {} : { params };
    if (!hasId) {
      return {
        kind: "notification",
        message: { jsonrpc: "2.0", method: value.method, ...base },
      };
    }
    return {
      kind: "request",
      message: { jsonrpc: "2.0", id: value.id as JsonRpcId, method: value.method, ...base },
    };
  }

  if (hasId && ("result" in value || "error" in value)) {
    if ("result" in value && "error" in value) {
      return invalid('a response cannot carry both "result" and "error"', id);
    }
    if ("result" in value && !isObject(value.result)) {
      return invalid('"result" must be an object', id);
    }
    if ("error" in value) {
      const error = value.error;
      if (!isObject(error) || typeof error.code !== "number" || typeof error.message !== "string") {
        return invalid('"error" must be an object with a numeric code and a message', id);
      }
    }
    return { kind: "response", message: value as unknown as JsonRpcResponse };
  }

  return invalid('expected "method", "result" or "error"', id);
}

export type Handler<Context> = (
  params: Record<string, unknown> | undefined,
  context: Context,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export type NotificationHandler<Context> = (
  params: Record<string, unknown> | undefined,
  context: Context,
) => void | Promise<void>;

export interface Handlers<Context> {
  requests: Readonly<Record<string, Handler<Context>>>;
  notifications?: Readonly<Record<string, NotificationHandler<Context>>>;
}

// Own properties only, so a method named "toString" or "__proto__" is an
// unknown method rather than a lookup on the prototype chain.
function lookup<T>(table: Readonly<Record<string, T>> | undefined, method: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, method) ? table[method] : undefined;
}

// Routes a request to its handler and always produces a response for it.
// Notifications produce none, whether or not a handler exists: JSON-RPC
// forbids answering them, so unknown ones are silently dropped.
export async function dispatch<Context>(
  message: JsonRpcRequest | JsonRpcNotification,
  handlers: Handlers<Context>,
  context: Context,
): Promise<JsonRpcResponse | undefined> {
  if (!("id" in message)) {
    const handler = lookup(handlers.notifications, message.method);
    if (handler) await handler(message.params, context);
    return undefined;
  }

  const handler = lookup(handlers.requests, message.method);
  if (!handler) {
    return errorResponse(
      message.id,
      ErrorCode.MethodNotFound,
      `Method not found: ${message.method}`,
    );
  }
  try {
    return successResponse(message.id, await handler(message.params, context));
  } catch (error) {
    if (error instanceof JsonRpcError) {
      return { jsonrpc: "2.0", id: message.id, error: error.toObject() };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return errorResponse(message.id, ErrorCode.InternalError, `Internal error: ${detail}`);
  }
}
