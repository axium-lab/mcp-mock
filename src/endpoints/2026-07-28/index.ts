import express, {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from "express";
import { dispatch, parseJson } from "../../core/jsonrpc.ts";
import type { Endpoint } from "../types.ts";
import { classify } from "./classify.ts";
import { type Rejection, reject, TRANSPORT_ERROR_CODE } from "./errors.ts";
import { handlers, REVISION } from "./handlers.ts";

const SUPPORTED_VERSIONS = [REVISION] as const;

function send(res: Response, { status, body }: Rejection): void {
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

// Streamable HTTP as of 2026-07-28: one POST per message, no session, no GET
// stream. Requests are answered with a single JSON body; the SSE response
// shape is reserved for progress and long-lived streams, which nothing here
// emits yet.
async function handlePost(req: Request, res: Response): Promise<void> {
  if (!acceptsBoth(req.headers.accept)) {
    return send(
      res,
      reject(406, undefined, TRANSPORT_ERROR_CODE, "Not Acceptable: Client must accept both application/json and text/event-stream"),
    );
  }
  if (mediaType(req.headers["content-type"]) !== "application/json") {
    return send(
      res,
      reject(415, undefined, TRANSPORT_ERROR_CODE, "Unsupported Media Type: Content-Type must be application/json"),
    );
  }

  const json = parseJson(typeof req.body === "string" ? req.body : "");
  if (!json.ok) return send(res, { status: 400, body: json.response });

  const classified = classify(
    json.value,
    {
      protocolVersion: req.get("mcp-protocol-version"),
      method: req.get("mcp-method"),
      name: req.get("mcp-name"),
    },
    {
      supportedVersions: SUPPORTED_VERSIONS,
      isKnownMethod: (method) => Object.hasOwn(handlers.requests, method),
    },
  );

  if ("status" in classified) return send(res, classified);
  if (classified.kind === "notification") {
    res.status(202).end();
    return;
  }

  // Handler errors (invalid params, unknown tool) travel in-band: the HTTP
  // exchange succeeded even though the JSON-RPC call did not.
  const response = await dispatch(classified.message, handlers, {
    protocolVersion: classified.protocolVersion,
  });
  res.status(200).json(response);
}

// GET and DELETE were the session stream and session teardown of earlier
// revisions; this one has neither.
function methodNotAllowed(_req: Request, res: Response): void {
  res.setHeader("Allow", "POST");
  send(res, reject(405, undefined, TRANSPORT_ERROR_CODE, "Method not allowed."));
}

// Body-parser failures (oversized bodies, unreadable encodings) keep their
// HTTP status and still answer with a JSON-RPC error body.
function bodyErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number") return next(err);
  const message = err instanceof Error ? err.message : "Bad Request";
  send(res, reject(status, undefined, TRANSPORT_ERROR_CODE, message));
}

export const endpoint20260728: Endpoint = {
  name: REVISION,
  mountPath: `/${REVISION}`,
  revisions: SUPPORTED_VERSIONS,
  createRouter() {
    const router = Router();
    // The raw text is parsed by the JSON-RPC core, which answers malformed
    // JSON with a proper parse error instead of Express's HTML page.
    router.use("/mcp", express.text({ type: () => true, limit: "4mb" }));
    router.post("/mcp", (req, res, next) => {
      handlePost(req, res).catch(next);
    });
    router.all("/mcp", methodNotAllowed);
    router.use("/mcp", bodyErrorHandler);
    return router;
  },
};
