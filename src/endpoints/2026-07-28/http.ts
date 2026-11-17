import type { NextFunction, Request, Response } from "express";
import { type Rejection, reject, TRANSPORT_ERROR_CODE } from "./errors.ts";

// Streamable HTTP mechanics that did not change between 2025-03-26 and
// 2026-07-28. Older revisions' endpoints import them from here.

export function send(res: Response, { status, body }: Rejection): void {
  res.status(status).json(body);
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

export function methodNotAllowed(_req: Request, res: Response): void {
  res.setHeader("Allow", "POST");
  send(res, reject(405, undefined, TRANSPORT_ERROR_CODE, "Method not allowed."));
}

// Body-parser failures (oversized bodies, unreadable encodings) keep their
// HTTP status and still answer with a JSON-RPC error body.
export function bodyErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number") return next(err);
  const message = err instanceof Error ? err.message : "Bad Request";
  send(res, reject(status, undefined, TRANSPORT_ERROR_CODE, message));
}
