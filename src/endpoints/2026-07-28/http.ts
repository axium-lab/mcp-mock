import type { NextFunction, Request, Response } from "express";
import { CONTROL, forcedStatus } from "../../core/control.ts";
import type { JsonRpcErrorResponse } from "../../core/jsonrpc.ts";
import { type Rejection, reject, TRANSPORT_ERROR_CODE } from "./errors.ts";

// Streamable HTTP mechanics that did not change between 2025-03-26 and
// 2026-07-28. Older revisions' endpoints import them from here.

// Gives an error body its revision's final form. The core omits the id of an
// error whose request id could not be read, as 2025-11-25 and later require;
// earlier revisions pass a shape that writes `id: null` instead.
export type ErrorShape = (body: JsonRpcErrorResponse) => JsonRpcErrorResponse;

const asIs: ErrorShape = (body) => body;

export function send(res: Response, { status, body }: Rejection, shape: ErrorShape = asIs): void {
  res.status(status).json(shape(body));
}

function mediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

// The client must accept both a JSON body and an SSE stream, since the server
// picks per request. Wildcards count as accepting.
function acceptsBoth(accept: string | undefined): boolean {
  const types = (accept ?? "").split(",").map(mediaType);
  const has = (type: string, family: string) =>
    types.includes(type) || types.includes(`${family}/*`) || types.includes("*/*");
  return has("application/json", "application") && has("text/event-stream", "text");
}

// The checks every POST passes before its body is read, with the status and
// message the official SDK server uses. Returns undefined when they pass.
export function checkPostHeaders(req: Request): Rejection | undefined {
  if (!acceptsBoth(req.headers.accept)) {
    return reject(
      406,
      undefined,
      TRANSPORT_ERROR_CODE,
      "Not Acceptable: Client must accept both application/json and text/event-stream",
    );
  }
  if (mediaType(req.headers["content-type"]) !== "application/json") {
    return reject(
      415,
      undefined,
      TRANSPORT_ERROR_CODE,
      "Unsupported Media Type: Content-Type must be application/json",
    );
  }
  return undefined;
}

// Answers the HTTP failure a test forces with x-mcp-mock-status, as a JSON-RPC
// error body the way the transport's other refusals are. Returns whether it
// answered.
export function sendForcedStatus(req: Request, res: Response, shape: ErrorShape = asIs): boolean {
  const forced = forcedStatus(req.get(CONTROL.statusHeader));
  if (!forced) return false;
  for (const [name, value] of Object.entries(forced.headers)) res.setHeader(name, value);
  send(res, reject(forced.status, undefined, TRANSPORT_ERROR_CODE, forced.message), shape);
  return true;
}

export interface Responder {
  // Sends a request-scoped notification (progress), switching the response
  // to an SSE stream on the first one.
  notify(message: unknown): void;
  // Sends the final response: as the last SSE event if streaming started,
  // otherwise as a plain JSON body with the given status.
  finish(status: number, body: unknown): void;
  // Aborted if the client closes the connection before the response ends.
  signal: AbortSignal;
}

// One response per request, JSON or SSE, decided late: the stream only
// starts if there is something to send before the result. Until then the
// status code stays free, so an error that the spec ties to an HTTP status
// (e.g. -32021 → 400) still gets it.
export function responder(res: Response): Responder {
  const aborted = new AbortController();
  let streaming = false;
  let done = false;
  res.on("close", () => {
    if (!done) aborted.abort();
  });
  const event = (message: unknown) => res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  return {
    signal: aborted.signal,
    notify(message) {
      if (done || aborted.signal.aborted) return;
      if (!streaming) {
        streaming = true;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
      }
      event(message);
    },
    finish(status, body) {
      if (done || aborted.signal.aborted) return;
      done = true;
      if (streaming) {
        event(body);
        res.end();
      } else {
        res.status(status).json(body);
      }
    },
  };
}

export function methodNotAllowedWith(shape: ErrorShape) {
  return (_req: Request, res: Response): void => {
    res.setHeader("Allow", "POST");
    send(res, reject(405, undefined, TRANSPORT_ERROR_CODE, "Method not allowed."), shape);
  };
}

// Body-parser failures (oversized bodies, unreadable encodings) keep their
// HTTP status and still answer with a JSON-RPC error body.
export function bodyErrorHandlerWith(shape: ErrorShape) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    const status = (err as { status?: unknown }).status;
    if (typeof status !== "number") return next(err);
    const message = err instanceof Error ? err.message : "Bad Request";
    send(res, reject(status, undefined, TRANSPORT_ERROR_CODE, message), shape);
  };
}

export const methodNotAllowed = methodNotAllowedWith(asIs);
export const bodyErrorHandler = bodyErrorHandlerWith(asIs);
