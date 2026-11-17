import { ErrorCode, JsonRpcError } from "../core/jsonrpc.ts";
import { add } from "./calc/add.ts";
import { calculate } from "./calc/calculate.ts";
import { colorSwatch } from "./calc/color-swatch.ts";
import { convertUnits } from "./calc/convert-units.ts";
import { dateDiff } from "./calc/date-diff.ts";
import { echo } from "./calc/echo.ts";
import { hashText } from "./calc/hash-text.ts";
import { sortList } from "./calc/sort-list.ts";
import { textStats } from "./calc/text-stats.ts";
import { transformText } from "./calc/transform-text.ts";
import type { Tool, ToolDefinition, ToolResult } from "./types.ts";
import { validateArgs } from "./validate.ts";
import { convertCurrency, getStockPrice } from "./world/finance.ts";
import { getUser, sendEmail } from "./world/people.ts";
import { geocode, getFlightStatus } from "./world/places.ts";
import { readFile } from "./world/read-file.ts";
import { searchWeb } from "./world/search-web.ts";
import { getForecast, getWeather } from "./world/weather.ts";

// The catalog, in listing order: real computations first, then the fake
// world. The spec asks for a deterministic order so clients and LLM prompt
// caches stay stable, and this one never changes between calls.
const TOOLS: readonly Tool[] = [
  echo,
  add,
  calculate,
  transformText,
  textStats,
  sortList,
  convertUnits,
  hashText,
  dateDiff,
  colorSwatch,
  getWeather,
  getForecast,
  searchWeb,
  getStockPrice,
  convertCurrency,
  getUser,
  geocode,
  getFlightStatus,
  readFile,
  sendEmail,
];

export function listTools(): ToolDefinition[] {
  return TOOLS.map((tool) => tool.definition);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// tools/call. Protocol errors (thrown) for a request the model cannot fix:
// malformed params, unknown tool. Tool execution errors (isError) for
// arguments it can, as 2025-11-25 made explicit.
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

  const problem = validateArgs(args, tool.definition.inputSchema);
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
