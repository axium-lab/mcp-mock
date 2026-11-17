import express, { type Request, type Response, Router } from "express";
import { dispatch, parseJson } from "../../core/jsonrpc.ts";
import type { Endpoint } from "../types.ts";
import { classify } from "./classify.ts";
import { handlers, REVISION } from "./handlers.ts";
import { bodyErrorHandler, checkPostHeaders, methodNotAllowed, send } from "./http.ts";

const SUPPORTED_VERSIONS = [REVISION] as const;

// Streamable HTTP as of 2026-07-28: one POST per message, no session, no GET
// stream. Requests are answered with a single JSON body; the SSE response
// shape is reserved for progress and long-lived streams, which nothing here
// emits yet.
async function handlePost(req: Request, res: Response): Promise<void> {
  const refused = checkPostHeaders(req);
  if (refused) return send(res, refused);

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
    // GET and DELETE were the session stream and session teardown of earlier
    // revisions; this one has neither.
    router.all("/mcp", methodNotAllowed);
    router.use("/mcp", bodyErrorHandler);
    return router;
  },
};
