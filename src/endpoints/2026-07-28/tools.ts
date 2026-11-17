import { ErrorCode, JsonRpcError } from "../../core/jsonrpc.ts";

// The tools this revision serves. Phase 1 ships only `echo`; the full
// catalog comes later. Pure: definitions and execution, no transport. Older
// revisions import it and reshape the result where their wire format differs.

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// tools/call. Protocol errors (thrown) for a request the model cannot fix:
// malformed params, unknown tool. Tool execution errors (isError) for
// arguments it can. 2025-11-25 is the first revision to say so explicitly.
export function callTool(params: Record<string, unknown> | undefined): ToolResult {
  const name = params?.name;
  if (typeof name !== "string") {
    throw new JsonRpcError(ErrorCode.InvalidParams, 'Invalid params: "name" must be a string');
  }
  const args = params?.arguments ?? {};
  if (!isObject(args)) {
    throw new JsonRpcError(ErrorCode.InvalidParams, 'Invalid params: "arguments" must be an object');
  }
  const tool = TOOLS.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new JsonRpcError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);

  const problem = tool.validate(args);
  if (problem !== undefined) {
    return {
      content: [{ type: "text", text: `Invalid arguments for tool ${name}: ${problem}` }],
      isError: true,
    };
  }
  return tool.run(args);
}

// The mock never paginates, so it never issues a cursor: any cursor a client
// sends is one it made up.
export function checkNoCursor(params: Record<string, unknown> | undefined): void {
  if (params?.cursor !== undefined) {
    throw new JsonRpcError(ErrorCode.InvalidParams, "Invalid params: unknown cursor");
  }
}
