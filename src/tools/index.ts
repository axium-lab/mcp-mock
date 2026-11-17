import { CONTROL, forcedInputRequired, forcedResult } from "../core/control.ts";
import { ErrorCode, JsonRpcError } from "../core/jsonrpc.ts";
import { add } from "./calc/add.ts";
import { calculate } from "./calc/calculate.ts";
import { colorSwatch } from "./calc/color-swatch.ts";
import { convertUnits } from "./calc/convert-units.ts";
import { dateDiff } from "./calc/date-diff.ts";
import { echo } from "./calc/echo.ts";
import { hashText } from "./calc/hash-text.ts";
import { simulateWork } from "./calc/simulate-work.ts";
import { sortList } from "./calc/sort-list.ts";
import { textStats } from "./calc/text-stats.ts";
import { transformText } from "./calc/transform-text.ts";
import {
  type CallContext,
  type InputRequired,
  structured,
  type Tool,
  type ToolDefinition,
  type ToolResult,
} from "./types.ts";
import { validateArgs } from "./validate.ts";
import { convertCurrency, getStockPrice } from "./world/finance.ts";
import { getUser, sendEmail } from "./world/people.ts";
import { geocode, getFlightStatus } from "./world/places.ts";
import { deleteFile } from "./world/delete-file.ts";
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
  simulateWork,
  getWeather,
  getForecast,
  searchWeb,
  getStockPrice,
  convertCurrency,
  getUser,
  geocode,
  getFlightStatus,
  readFile,
  deleteFile,
  sendEmail,
];

export function listTools(): ToolDefinition[] {
  return TOOLS.map((tool) => tool.definition);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CallOptions {
  // How arguments that break the input schema are reported. 2025-11-25 made
  // them a tool execution error (isError) so the model can self-correct;
  // 2025-06-18 and earlier listed "invalid arguments" among protocol errors.
  invalidArguments?: "tool-error" | "protocol-error";
  // Set by revisions with multi round-trip requests (2026-07-28): what a tool
  // needs to ask the client for input and read its answers.
  mrtr?: CallContext["mrtr"];
  // Progress reporting and cancellation, when the transport can carry them.
  report?: CallContext["report"];
  signal?: CallContext["signal"];
  instant?: boolean;
}

// tools/call. Protocol errors (thrown) for a request the model cannot fix:
// malformed params, unknown tool. Tool execution errors (isError) for what
// it can: business failures, and invalid arguments unless told otherwise.
export function callTool(
  params: Record<string, unknown> | undefined,
  options: CallOptions = {},
): ToolResult | InputRequired | Promise<ToolResult> {
  const name = params?.name;
  if (typeof name !== "string") {
    throw new JsonRpcError(ErrorCode.InvalidParams, 'Invalid params: "name" must be a string');
  }

  // An input request forced from the test. The client retries with the
  // same params, _meta included, plus its answers; a retry is recognised by
  // those answers and is not asked again. It gets the forced result if there
  // is one, and otherwise what the client answered, for the test to check.
  const forcedInput = forcedInputRequired(params);
  if (forcedInput) {
    if (!options.mrtr) {
      throw new JsonRpcError(
        ErrorCode.InvalidParams,
        `Invalid params: _meta ${CONTROL.inputRequired} needs protocol revision 2026-07-28, the first with multi round-trip requests`,
      );
    }
    const isRetry = params?.inputResponses !== undefined || params?.requestState !== undefined;
    if (!isRetry) return { resultType: "input_required", ...forcedInput };
    const forcedAfter = forcedResult(params);
    if (forcedAfter) return forcedAfter as unknown as ToolResult;
    return structured({
      inputResponses: (params?.inputResponses ?? {}) as Record<string, unknown>,
      ...(params?.requestState !== undefined && { requestState: params.requestState }),
    });
  }

  // A result forced from the test replaces the tool's own, for any name and
  // without validating the arguments: the test decides the answer. Its blocks
  // pass through unchecked, so they share the catalog's type only nominally.
  const forced = forcedResult(params);
  if (forced) return forced as unknown as ToolResult;

  const args = params?.arguments ?? {};
  if (!isObject(args)) {
    throw new JsonRpcError(ErrorCode.InvalidParams, 'Invalid params: "arguments" must be an object');
  }
  const tool = TOOLS.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new JsonRpcError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);

  const problem = validateArgs(args, tool.definition.inputSchema);
  if (problem !== undefined) {
    const message = `Invalid arguments for tool ${name}: ${problem}`;
    if (options.invalidArguments === "protocol-error") {
      throw new JsonRpcError(ErrorCode.InvalidParams, message);
    }
    return { content: [{ type: "text", text: message }], isError: true };
  }
  return tool.run(args, {
    ...(options.mrtr && { mrtr: options.mrtr }),
    ...(options.report && { report: options.report }),
    ...(options.signal && { signal: options.signal }),
    ...(options.instant && { instant: true }),
  });
}

// The mock never paginates, so it never issues a cursor: any cursor a client
// sends is one it made up.
export function checkNoCursor(params: Record<string, unknown> | undefined): void {
  if (params?.cursor !== undefined) {
    throw new JsonRpcError(ErrorCode.InvalidParams, "Invalid params: unknown cursor");
  }
}
