// The tool catalog, independent of any spec revision: definitions and pure
// execution. Endpoints import it and reshape results where their revision's
// wire format differs.

export type JsonSchema = Record<string, unknown>;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations: ToolAnnotations;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; description?: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; text: string } };

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type Args = Record<string, unknown>;

// Multi round-trip requests (MRTR), 2026-07-28 only: instead of a result, a
// tool may answer that it needs input from the client first. The client
// gathers it and retries the call with `inputResponses`, echoing
// `requestState` untouched.
export interface InputRequired {
  resultType: "input_required";
  inputRequests?: Record<string, Record<string, unknown>>;
  requestState?: string;
}

export interface Progress {
  progress: number;
  total?: number;
  message?: string;
}

export interface CallContext {
  // Present only where the revision has MRTR. Absent, a tool must complete
  // without asking: legacy revisions cannot carry an input request.
  mrtr?: {
    clientCapabilities: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
  };
  // Present when the request asked for progress (a progressToken in _meta).
  report?: (progress: Progress) => void;
  // Aborted when the request is cancelled.
  signal?: AbortSignal;
}

// MissingRequiredClientCapability, the 2026-07-28 error for a request that
// needs a capability the client did not declare. Only thrown under MRTR.
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;

export interface Tool {
  definition: ToolDefinition;
  // Receives arguments already validated against the input schema. Only
  // tools that take time (simulate_work) answer asynchronously.
  run(args: Args, context: CallContext): ToolResult | InputRequired | Promise<ToolResult>;
}

export function isInputRequired(result: ToolResult | InputRequired): result is InputRequired {
  return (result as InputRequired).resultType === "input_required";
}

// A result whose data is also given as JSON text: the spec asks tools that
// return structured content to serialize it in a text block too, for clients
// that only read text.
export function structured(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

// A tool execution error: reported in the result so the model can read it and
// retry, not as a protocol error.
export function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
