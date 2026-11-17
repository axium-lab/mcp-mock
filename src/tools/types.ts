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

export interface Tool {
  definition: ToolDefinition;
  // Receives arguments already validated against the input schema.
  run(args: Args): ToolResult;
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
