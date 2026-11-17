import express, { type Request, type Response, Router } from "express";
import { dispatch, ErrorCode, parseJson, parseMessage } from "../../core/jsonrpc.ts";
import { reject, TRANSPORT_ERROR_CODE } from "../2026-07-28/errors.ts";
import { bodyErrorHandler, checkPostHeaders, methodNotAllowed, send } from "../2026-07-28/http.ts";
import type { Endpoint } from "../types.ts";
import { handlers, REVISION } from "./handlers.ts";

const SUPPORTED_VERSIONS = [REVISION] as const;

// Streamable HTTP as of 2025-11-25, served without sessions. The spec makes
// both optional: a server MAY assign an Mcp-Session-Id at initialize and MAY
// refuse the GET stream with 405. Without them every POST stands alone, which
// keeps the mock stateless; the cost is that a request is served even if no
// initialize came before it, since nothing ties the two together.
async function handlePost(req: Request, res: Response): Promise<void> {
  const refused = checkPostHeaders(req);
  if (refused) return send(res, refused);

  const json = parseJson(typeof req.body === "string" ? req.body : "");
  if (!json.ok) return send(res, { status: 400, body: json.response });

  // Batches were removed in 2025-06-18: the body is a single message.
  if (Array.isArray(json.value)) {
    return send(
      res,
      reject(400, undefined, ErrorCode.InvalidRequest, "Invalid Request: JSON-RPC batches are not supported"),
    );
  }
  const parsed = parseMessage(json.value);
  if (parsed.kind === "invalid") return send(res, { status: 400, body: parsed.response });

  // Every message after initialize carries the negotiated version. A missing
  // header is accepted: the spec's fallback (assume 2025-03-26) is for servers
  // with no other way to tell, and this endpoint's path already pins the
  // version. A header naming another version is refused, as the official SDK
  // server does.
  const isInitialize = parsed.kind === "request" && parsed.message.method === "initialize";
  const version = req.get("mcp-protocol-version")?.trim();
  if (!isInitialize && version !== undefined && !SUPPORTED_VERSIONS.includes(version as typeof REVISION)) {
    return send(
      res,
      reject(
        400,
        undefined,
        TRANSPORT_ERROR_CODE,
        `Bad Request: Unsupported protocol version: ${version} (supported versions: ${SUPPORTED_VERSIONS.join(", ")})`,
      ),
    );
  }

  // Notifications (initialized, cancelled) and responses to server requests
  // (the mock sends none) are accepted and dropped.
  if (parsed.kind !== "request") {
    res.status(202).end();
    return;
  }

  // Every JSON-RPC error, unknown methods included, travels in-band: this
  // revision ties no HTTP status to them.
  const response = await dispatch(parsed.message, handlers, {});
  res.status(200).json(response);
}

export const endpoint20251125: Endpoint = {
  name: REVISION,
  mountPath: `/${REVISION}`,
  revisions: SUPPORTED_VERSIONS,
  createRouter() {
    const router = Router();
    router.use("/mcp", express.text({ type: () => true, limit: "4mb" }));
    router.post("/mcp", (req, res, next) => {
      handlePost(req, res).catch(next);
    });
    // GET would open the server-to-client stream and DELETE would end a
    // session; the mock offers neither, which the spec answers with 405.
    router.all("/mcp", methodNotAllowed);
    router.use("/mcp", bodyErrorHandler);
    return router;
  },
};
