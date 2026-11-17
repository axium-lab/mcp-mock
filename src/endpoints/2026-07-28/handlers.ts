import { withControl } from "../../core/control.ts";
import { ErrorCode, type Handlers } from "../../core/jsonrpc.ts";
import { getPrompt, listPrompts } from "../../prompts/index.ts";
import { listResources, listResourceTemplates, readResource } from "../../resources/index.ts";
import { TASKS_EXTENSION } from "../../tasks/index.ts";
import { callTool, checkNoCursor, listTools } from "../../tools/index.ts";
import { isInputRequired, type Progress } from "../../tools/types.ts";
import { CACHE_HINTS, complete, SERVER_META } from "./results.ts";
import { clientCapabilitiesOf, createTask, taskDuration, taskHandlers } from "./tasks.ts";

export const REVISION = "2026-07-28";

export interface RequestContext {
  protocolVersion: string;
  // Set when the request carries a progress token.
  report?: (progress: Progress) => void;
  // Aborted when the client closes the response stream, which cancels the
  // request in this revision.
  signal?: AbortSignal;
}

// withControl lets a request force a JSON-RPC error from the test.
export const handlers: Handlers<RequestContext> = withControl({
  requests: {
    // listChanged and subscribe: subscriptions/listen honors every list and
    // resource subscription (the changes themselves are scripted by tests).
    // The tasks extension is offered to clients that declare it.
    "server/discover": () =>
      complete({
        supportedVersions: [REVISION],
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true, subscribe: true },
          prompts: { listChanged: true },
          extensions: { [TASKS_EXTENSION]: {} },
        },
        ...CACHE_HINTS,
      }),

    "tools/list": (params) => {
      checkNoCursor(params);
      return complete({ tools: listTools(), ...CACHE_HINTS });
    },

    // tools/call may answer:
    // - a task (tasks extension), for slow calls of clients that declare it;
    // - input_required (MRTR), when the tool needs input first: an interim
    //   result, not "complete", with no cache hints;
    // - its result.
    "tools/call": async (params, context) => {
      const duration = taskDuration(params);
      if (duration !== undefined && params) return createTask(params, duration, Date.now());

      const result = await callTool(params, {
        mrtr: {
          clientCapabilities: clientCapabilitiesOf(params),
          ...(params?.inputResponses !== undefined && {
            inputResponses: params.inputResponses as Record<string, unknown>,
          }),
          ...(typeof params?.requestState === "string" && { requestState: params.requestState }),
        },
        ...(context.report && { report: context.report }),
        ...(context.signal && { signal: context.signal }),
      });
      if (isInputRequired(result)) return { ...result, _meta: SERVER_META };
      return complete(result);
    },

    ...taskHandlers,

    "resources/list": (params) => {
      checkNoCursor(params);
      return complete({ resources: listResources(), ...CACHE_HINTS });
    },

    "resources/templates/list": (params) => {
      checkNoCursor(params);
      return complete({ resourceTemplates: listResourceTemplates(), ...CACHE_HINTS });
    },

    // resources/read is cacheable too. A missing resource is -32602 (Invalid
    // Params) since this revision, no longer -32002.
    "resources/read": (params) => complete({ ...readResource(params, ErrorCode.InvalidParams), ...CACHE_HINTS }),

    "prompts/list": (params) => {
      checkNoCursor(params);
      return complete({ prompts: listPrompts(), ...CACHE_HINTS });
    },

    // prompts/get depends on its arguments and is not among the cacheable
    // results.
    "prompts/get": (params) => complete(getPrompt(params)),
  },
});
