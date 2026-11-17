// The tools this revision serves. Phase 1 ships only `echo`; the full
// catalog comes later. Pure: definitions and execution, no transport.

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface Tool {
  definition: ToolDefinition;
  // Returns an error message for arguments that break the input schema. The
  // spec reports those as a tool execution error (isError), not a protocol
  // error, so the model can read it and retry.
  validate(args: Record<string, unknown>): string | undefined;
  run(args: Record<string, unknown>): ToolResult;
}

const echo: Tool = {
  definition: {
    name: "echo",
    title: "Echo",
    description: 'Returns the given text prefixed with "Echo: ".',
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to echo back." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  validate(args) {
    if (typeof args.text !== "string") return '"text" is required and must be a string';
    const extra = Object.keys(args).filter((key) => key !== "text");
    if (extra.length > 0) return `unexpected argument(s): ${extra.join(", ")}`;
    return undefined;
  },
  run(args) {
    return { content: [{ type: "text", text: `Echo: ${args.text as string}` }] };
  },
};

// Listing order is the declaration order: the spec asks for a deterministic
// order so clients and LLM prompt caches stay stable.
const TOOLS: readonly Tool[] = [echo];

export function listTools(): ToolDefinition[] {
  return TOOLS.map((tool) => tool.definition);
}

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.definition.name === name);
}
