import express, { type Request, type Response, Router } from "express";
import { dispatch, ErrorCode, parseJson, parseMessage } from "../../core/jsonrpc.ts";
import { reject, TRANSPORT_ERROR_CODE } from "../2026-07-28/errors.ts";
import {
  bodyErrorHandlerWith,
  checkPostHeaders,
  methodNotAllowedWith,
  send,
} from "../2026-07-28/http.ts";
import type { Endpoint } from "../types.ts";
import { legacyHandlers } from "./handlers.ts";
import { type LegacyProfile, PROFILE_2025_11_25, shapeFor } from "./profile.ts";

// Legacy Streamable HTTP (2025-03-26 to 2025-11-25), served without sessions.
// The spec makes them optional: a server MAY assign an Mcp-Session-Id at
// initialize and MAY refuse the GET stream with 405. Without them every POST
// stands alone, which keeps the mock stateless; the cost is that a request is
// served even if no initialize came before it, since nothing ties the two
// together.
//
// One server for every legacy revision, driven by profiles (newest first):
// the pinned endpoints pass one, the dual-era /mcp passes all it serves.

// Which revision serves a message. initialize names the version it wants,
// and gets it when served, the newest otherwise. Every later message carries
// the negotiated version in MCP-Protocol-Version; a header naming a version
// not served is refused. A missing header gets the newest profile: the
// spec's fallback (assume 2025-03-26) is for servers with no other way to
// tell, and a pinned endpoint's path already tells.
function profileFor(
  message: { method?: string; params?: Record<string, unknown> } | undefined,
  headerVersion: string | undefined,
  profiles: readonly LegacyProfile[],
): LegacyProfile | undefined {
  const newest = profiles[0] as LegacyProfile;
  if (message?.method === "initialize") {
    const requested = message.params?.protocolVersion;
    return profiles.find((profile) => profile.revision === requested) ?? newest;
  }
  if (headerVersion === undefined) return newest;
  return profiles.find((profile) => profile.revision === headerVersion);
}

const handlerCache = new Map<LegacyProfile, ReturnType<typeof legacyHandlers>>();
function handlersFor(profile: LegacyProfile) {
  let handlers = handlerCache.get(profile);
  if (!handlers) {
    handlers = legacyHandlers(profile);
    handlerCache.set(profile, handlers);
  }
  return handlers;
}

// Serves one already-decoded POST body. Exported for the dual-era /mcp
// endpoint, which routes legacy traffic here.
export async function serveLegacy(
  body: unknown,
  req: Request,
  res: Response,
  profiles: readonly LegacyProfile[],
): Promise<void> {
  const headerVersion = req.get("mcp-protocol-version")?.trim();
  // Before the body is understood, errors take the shape of the revision the
  // header names, or of the newest one served.
  const early = shapeFor(
    profiles.find((profile) => profile.revision === headerVersion) ?? (profiles[0] as LegacyProfile),
  );

  // Batches were removed in 2025-06-18: the body is a single message.
  if (Array.isArray(body)) {
    return send(
      res,
      reject(400, undefined, ErrorCode.InvalidRequest, "Invalid Request: JSON-RPC batches are not supported"),
      early,
    );
  }
  const parsed = parseMessage(body);
  if (parsed.kind === "invalid") return send(res, { status: 400, body: parsed.response }, early);

  const message = parsed.kind === "response" ? undefined : parsed.message;
  const profile = profileFor(message, headerVersion, profiles);
  if (!profile) {
    return send(
      res,
      reject(
        400,
        undefined,
        TRANSPORT_ERROR_CODE,
        `Bad Request: Unsupported protocol version: ${headerVersion} (supported versions: ${profiles.map((p) => p.revision).join(", ")})`,
      ),
      early,
    );
  }

  // Notifications (initialized, cancelled) and responses to server requests
  // (the mock sends none) are accepted and dropped.
  if (parsed.kind !== "request") {
    res.status(202).end();
    return;
  }

  // Every JSON-RPC error, unknown methods included, travels in-band: legacy
  // revisions tie no HTTP status to them.
  const response = await dispatch(parsed.message, handlersFor(profile), {});
  res.status(200).json(response);
}

// The router of a pinned legacy endpoint (one profile). 2025-06-18 and older
// revisions build theirs with it.
export function legacyRouter(profiles: readonly LegacyProfile[]): Router {
  const shape = shapeFor(profiles[0] as LegacyProfile);
  const router = Router();
  router.use("/mcp", express.text({ type: () => true, limit: "4mb" }));
  router.post("/mcp", (req, res, next) => {
    (async () => {
      const refused = checkPostHeaders(req);
      if (refused) return send(res, refused, shape);
      const json = parseJson(typeof req.body === "string" ? req.body : "");
      if (!json.ok) return send(res, { status: 400, body: json.response }, shape);
      await serveLegacy(json.value, req, res, profiles);
    })().catch(next);
  });
  // GET would open the server-to-client stream and DELETE would end a
  // session; the mock offers neither, which the spec answers with 405.
  router.all("/mcp", methodNotAllowedWith(shape));
  router.use("/mcp", bodyErrorHandlerWith(shape));
  return router;
}

export const endpoint20251125: Endpoint = {
  name: PROFILE_2025_11_25.revision,
  mountPath: `/${PROFILE_2025_11_25.revision}`,
  revisions: [PROFILE_2025_11_25.revision as "2025-11-25"],
  createRouter: () => legacyRouter([PROFILE_2025_11_25]),
};
