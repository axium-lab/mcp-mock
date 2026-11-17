import express, { type Request, type Response, Router } from "express";
import { dispatch, parseJson } from "../../core/jsonrpc.ts";
import type { Endpoint } from "../types.ts";
import { classify } from "./classify.ts";
import { handlers, REVISION } from "./handlers.ts";
import { bodyErrorHandler, checkPostHeaders, methodNotAllowed, send } from "./http.ts";

export const MODERN_VERSIONS = [REVISION] as const;

// Serves one already-decoded POST body as 2026-07-28: one message per POST, no
// session. Requests are answered with a single JSON body; the SSE response
// shape is reserved for progress and long-lived streams, which nothing here
// emits yet. Exported for the dual-era /mcp endpoint, which routes modern
// traffic here.
export async function serveModern(body: unknown, req: Request, res: Response): Promise<void> {
  const classified = classify(
    body,
    {
      protocolVersion: req.get("mcp-protocol-version"),
      method: req.get("mcp-method"),
      name: req.get("mcp-name"),
    },
    {
      supportedVersions: MODERN_VERSIONS,
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

async function handlePost(req: Request, res: Response): Promise<void> {
  const refused = checkPostHeaders(req);
  if (refused) return send(res, refused);

  const json = parseJson(typeof req.body === "string" ? req.body : "");
  if (!json.ok) return send(res, { status: 400, body: json.response });

  await serveModern(json.value, req, res);
}

export const endpoint20260728: Endpoint = {
  name: REVISION,
  mountPath: `/${REVISION}`,
  revisions: MODERN_VERSIONS,
  createRouter() {
    const router = Router();
    // The raw text is parsed by the JSON-RPC core, which answers malformed
    // JSON with a proper parse error instead of Express's HTML page.
    router.use("/mcp", express.text({ type: () => true, limit: "4mb" }));
    router.post("/mcp", (req, res, next) => {
      handlePost(req, res).catch(next);
    });
    // GET and DELETE were the session stream and session teardown of earlier
    // revisions; this one has neither.
    router.all("/mcp", methodNotAllowed);
    router.use("/mcp", bodyErrorHandler);
    return router;
  },
};
