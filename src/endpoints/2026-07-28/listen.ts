import type { Response } from "express";
import { CONTROL, notificationScript, type ScriptedEvent } from "../../core/control.ts";
import { ErrorCode, type JsonRpcRequest, JsonRpcError } from "../../core/jsonrpc.ts";
import { SERVER_INFO } from "../../core/server-info.ts";
import { readResource } from "../../resources/index.ts";
import { META } from "./envelope.ts";

// subscriptions/listen: a long-lived request whose response is an SSE stream
// of change notifications, replacing the GET stream and resources/subscribe
// of earlier revisions. The stream's state lives in the request: it ends
// when the client closes it, or when the server closes it gracefully.
//
// The catalog never changes on its own, so without a script the stream is
// acknowledged, kept alive, and stays quiet, which is the truth. With
// _meta["com.mcp-mock/notifications"] the test scripts the changes it wants
// its client to see.

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const KEEP_ALIVE_MS = 15_000;

interface Filter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exists(uri: string): boolean {
  try {
    readResource({ uri }, ErrorCode.InvalidParams);
    return true;
  } catch {
    return false;
  }
}

// What the server agrees to honor, which the acknowledgment reports: every
// list it has, and the subscribed resources that exist.
function honored(filter: Record<string, unknown>): Filter {
  const result: Filter = {};
  for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"] as const) {
    if (filter[key] === true) result[key] = true;
  }
  if (Array.isArray(filter.resourceSubscriptions)) {
    const uris = filter.resourceSubscriptions.filter((uri): uri is string => typeof uri === "string" && exists(uri));
    if (uris.length > 0) result.resourceSubscriptions = uris;
  }
  return result;
}

const METHODS: Record<Exclude<ScriptedEvent["kind"], "resourceUpdated">, string> = {
  toolsListChanged: "notifications/tools/list_changed",
  promptsListChanged: "notifications/prompts/list_changed",
  resourcesListChanged: "notifications/resources/list_changed",
};

// The server MUST NOT send what the client did not ask for, so a script that
// announces an unsubscribed change is refused rather than half played.
function checkScript(events: ScriptedEvent[], filter: Filter): void {
  for (const event of events) {
    const allowed =
      event.kind === "resourceUpdated"
        ? (filter.resourceSubscriptions ?? []).includes(event.uri)
        : filter[event.kind] === true;
    if (!allowed) {
      const what = event.kind === "resourceUpdated" ? `resource updates for ${event.uri}` : event.kind;
      throw new JsonRpcError(
        ErrorCode.InvalidParams,
        `Invalid params: _meta ${CONTROL.notifications} announces ${what}, which this subscription does not include`,
      );
    }
  }
}

// Answers a subscriptions/listen request. Errors before the stream opens are
// plain JSON-RPC errors, in-band like any handler error.
export function serveListen(message: JsonRpcRequest, res: Response): void {
  const { id, params } = message;
  const meta = { [SUBSCRIPTION_ID]: id };
  let filter: Filter;
  let script: ReturnType<typeof notificationScript>;
  try {
    const forced = (params?._meta as Record<string, unknown> | undefined)?.[CONTROL.error];
    if (isObject(forced) && Number.isInteger(forced.code) && typeof forced.message === "string") {
      throw new JsonRpcError(forced.code as number, forced.message, forced.data);
    }
    if (!isObject(params?.notifications)) {
      throw new JsonRpcError(ErrorCode.InvalidParams, 'Invalid params: "notifications" must be an object');
    }
    filter = honored(params.notifications);
    script = notificationScript(params);
    if (script) checkScript(script.events, filter);
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error;
    res.status(200).json({ jsonrpc: "2.0", id, error: error.toObject() });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (body: unknown) => res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
  const timers: ReturnType<typeof setTimeout>[] = [];
  // SSE comments keep idle intermediaries from closing a quiet stream.
  const keepAlive = setInterval(() => res.write(":\n\n"), KEEP_ALIVE_MS);
  keepAlive.unref?.();
  res.on("close", () => {
    clearInterval(keepAlive);
    for (const timer of timers) clearTimeout(timer);
  });

  // The acknowledgment comes first, before any notification of the stream.
  send({
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: { _meta: meta, notifications: filter },
  });

  if (!script) return;
  const { events, intervalMs, close } = script;
  events.forEach((event, index) => {
    timers.push(
      setTimeout(
        () =>
          send(
            event.kind === "resourceUpdated"
              ? { jsonrpc: "2.0", method: "notifications/resources/updated", params: { _meta: meta, uri: event.uri } }
              : { jsonrpc: "2.0", method: METHODS[event.kind], params: { _meta: meta } },
          ),
        intervalMs * (index + 1),
      ),
    );
  });
  if (close) {
    // A graceful end: the long-lived request finally gets its response.
    timers.push(
      setTimeout(
        () => {
          send({
            jsonrpc: "2.0",
            id,
            result: { resultType: "complete", _meta: { ...meta, [META.serverInfo]: SERVER_INFO } },
          });
          res.end();
        },
        intervalMs * (events.length + 1),
      ),
    );
  }
}
