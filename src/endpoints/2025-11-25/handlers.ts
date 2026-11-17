import { withControl } from "../../core/control.ts";
import { ErrorCode, type Handlers, JsonRpcError } from "../../core/jsonrpc.ts";
import { SERVER_INFO } from "../../core/server-info.ts";
import { getPrompt, listPrompts } from "../../prompts/index.ts";
import { listResources, listResourceTemplates, readResource } from "../../resources/index.ts";
import { callTool, checkNoCursor, listTools } from "../../tools/index.ts";
import { isInputRequired, type Progress } from "../../tools/types.ts";
import type { LegacyProfile } from "./profile.ts";

// Resource not found, a code of the legacy revisions; 2026-07-28 replaced it
// with -32602.
const RESOURCE_NOT_FOUND = -32002;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Drops the display title from a definition, for revisions before
// 2025-06-18, which had none.
function withoutTitle<T extends { title?: string }>(definition: T): Omit<T, "title"> {
  const { title: _title, ...rest } = definition;
  return rest;
}

export interface LegacyContext {
  // Set when the request carries a progress token.
  report?: (progress: Progress) => void;
  // Aborted when the request is cancelled: only on the 2024-11-05 SSE
  // transport, whose session can pair a notifications/cancelled with it.
  signal?: AbortSignal;
}

// The methods of a legacy revision. Results are plain objects: resultType,
// cache hints and serverInfo in _meta only arrived with 2026-07-28.
export function legacyHandlers(profile: LegacyProfile): Handlers<LegacyContext> {
  const adaptDefinition = profile.adaptDefinition ?? ((definition) => ({ ...definition }));
  const adaptResult = profile.adaptResult ?? ((result) => ({ ...result }));
  const titled = <T extends { title?: string }>(definition: T) => (profile.titles ? definition : withoutTitle(definition));

  // withControl lets a request force a JSON-RPC error from the test.
  return withControl({
    requests: {
      // The profile was chosen from the requested version (or as the newest
      // served when that one is not), so answering with its revision is the
      // spec's negotiation: the requested version when supported, another
      // supported one otherwise, never an error. A client that cannot use the
      // answer disconnects.
      initialize: (params) => {
        if (
          typeof params?.protocolVersion !== "string" ||
          !isObject(params.capabilities) ||
          !isObject(params.clientInfo)
        ) {
          throw new JsonRpcError(
            ErrorCode.InvalidParams,
            'Invalid params: initialize requires "protocolVersion", "capabilities" and "clientInfo"',
          );
        }
        return {
          protocolVersion: profile.revision,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
        };
      },

      ping: () => ({}),

      "tools/list": (params) => {
        checkNoCursor(params);
        return { tools: listTools().map(adaptDefinition) };
      },

      // No MRTR context: legacy revisions cannot carry an input request, so
      // tools complete without asking and input_required never comes back.
      "tools/call": async (params, context) => {
        const result = await callTool(params, {
          invalidArguments: profile.invalidArguments,
          ...(context.report && { report: context.report }),
          ...(context.signal && { signal: context.signal }),
        });
        if (isInputRequired(result)) throw new Error("input_required outside 2026-07-28");
        return adaptResult(result);
      },

      "resources/list": (params) => {
        checkNoCursor(params);
        return { resources: listResources().map(titled) };
      },

      "resources/templates/list": (params) => {
        checkNoCursor(params);
        return { resourceTemplates: listResourceTemplates().map(titled) };
      },

      "resources/read": (params) => readResource(params, RESOURCE_NOT_FOUND),

      "prompts/list": (params) => {
        checkNoCursor(params);
        return {
          prompts: listPrompts().map((prompt) =>
            profile.titles ? prompt : { ...withoutTitle(prompt), arguments: prompt.arguments.map(withoutTitle) },
          ),
        };
      },

      "prompts/get": (params) => getPrompt(params),
    },
  });
}
