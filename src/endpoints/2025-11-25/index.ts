import express, { type Request, type Response, Router } from "express";
import {
  dispatch,
  ErrorCode,
  errorResponse,
  type JsonRpcResponse,
  parseJson,
  parseMessage,
} from "../../core/jsonrpc.ts";
import { type Rejection, reject, TRANSPORT_ERROR_CODE } from "../2026-07-28/errors.ts";
import {
  bodyErrorHandlerWith,
  checkPostHeaders,
  methodNotAllowedWith,
  send,
  sendForcedStatus,
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

// The revision a message without MCP-Protocol-Version is served as. The
// header arrived in 2025-06-18, so the spec has servers assume 2025-03-26
// when they have no other way to tell; a pinned endpoint's path tells, and it
// has a single profile anyway.
export function defaultProfile(profiles: readonly LegacyProfile[]): LegacyProfile {
  return profiles.find((profile) => profile.revision === "2025-03-26") ?? (profiles[0] as LegacyProfile);
}

// Which revision serves a message. initialize names the version it wants,
// and gets it when served, the newest otherwise. Every later message carries
// the negotiated version in MCP-Protocol-Version; a header naming a version
// not served is refused.
export function profileFor(
  message: { method?: string; params?: Record<string, unknown> } | undefined,
  headerVersion: string | undefined,
  profiles: readonly LegacyProfile[],
): LegacyProfile | undefined {
  if (message?.method === "initialize") {
    const requested = message.params?.protocolVersion;
    return profiles.find((profile) => profile.revision === requested) ?? (profiles[0] as LegacyProfile);
  }
  if (headerVersion === undefined) return defaultProfile(profiles);
  return profiles.find((profile) => profile.revision === headerVersion);
}

const handlerCache = new Map<LegacyProfile, ReturnType<typeof legacyHandlers>>();
export function handlersFor(profile: LegacyProfile) {
  let handlers = handlerCache.get(profile);
  if (!handlers) {
    handlers = legacyHandlers(profile);
    handlerCache.set(profile, handlers);
  }
  return handlers;
}

function unsupportedHeader(headerVersion: string, profiles: readonly LegacyProfile[]) {
  return reject(
    400,
    undefined,
    TRANSPORT_ERROR_CODE,
    `Bad Request: Unsupported protocol version: ${headerVersion} (supported versions: ${profiles.map((p) => p.revision).join(", ")})`,
  );
}

export type BatchOutcome =
  | { kind: "accepted" }
  | { kind: "answers"; answers: JsonRpcResponse[] }
  | { kind: "refused"; rejection: Rejection };

// A JSON-RPC batch, for the revision that has them (2025-03-26). Requests and
// notifications may be batched together, responses only with responses.
// Each element is answered on its own, as JSON-RPC prescribes: a malformed
// element gets its error in the response array without failing the others.
// Transport-neutral, so the 2024-11-05 SSE transport can deliver the answers
// on its stream.
export async function answerBatch(batch: unknown[], profile: LegacyProfile): Promise<BatchOutcome> {
  const shape = shapeFor(profile);
  const refused = (message: string): BatchOutcome => {
    const rejection = reject(400, undefined, ErrorCode.InvalidRequest, `Invalid Request: ${message}`);
    return { kind: "refused", rejection: { ...rejection, body: shape(rejection.body) } };
  };
  if (batch.length === 0) return refused("empty batch");

  const parsed = batch.map(parseMessage);
  const responses = parsed.filter((element) => element.kind === "response").length;
  if (responses === parsed.length) return { kind: "accepted" };
  if (responses > 0) return refused("a batch cannot mix responses with requests or notifications");

  const answers: JsonRpcResponse[] = [];
  for (const element of parsed) {
    if (element.kind === "invalid") {
      answers.push(shape(element.response));
    } else if (element.kind === "request" && element.message.method === "initialize") {
      // Nothing else is possible until initialization completes, so the
      // spec forbids batching it.
      answers.push(
        errorResponse(element.message.id, ErrorCode.InvalidRequest, "Invalid Request: initialize must not be part of a JSON-RPC batch"),
      );
    } else if (element.kind === "request") {
      answers.push((await dispatch(element.message, handlersFor(profile), {})) as JsonRpcResponse);
    }
    // Notifications are accepted and get no answer.
  }
  return answers.length === 0 ? { kind: "accepted" } : { kind: "answers", answers };
}

async function serveBatch(batch: unknown[], res: Response, profile: LegacyProfile): Promise<void> {
  const outcome = await answerBatch(batch, profile);
  if (outcome.kind === "refused") return send(res, outcome.rejection);
  if (outcome.kind === "accepted") {
    res.status(202).end();
    return;
  }
  res.status(200).json(outcome.answers);
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
  // header names, or of the one a missing header means.
  const early = shapeFor(
    headerVersion === undefined
      ? defaultProfile(profiles)
      : (profiles.find((profile) => profile.revision === headerVersion) ?? (profiles[0] as LegacyProfile)),
  );

  if (Array.isArray(body)) {
    // A batch cannot contain initialize, so its revision comes from the
    // header alone.
    const profile = profileFor(undefined, headerVersion, profiles);
    if (!profile) return send(res, unsupportedHeader(headerVersion as string, profiles), early);
    if (!profile.batching) {
      return send(
        res,
        reject(400, undefined, ErrorCode.InvalidRequest, "Invalid Request: JSON-RPC batches are not supported"),
        early,
      );
    }
    return serveBatch(body, res, profile);
  }

  const parsed = parseMessage(body);
  if (parsed.kind === "invalid") return send(res, { status: 400, body: parsed.response }, early);

  const message = parsed.kind === "response" ? undefined : parsed.message;
  const profile = profileFor(message, headerVersion, profiles);
  if (!profile) return send(res, unsupportedHeader(headerVersion as string, profiles), early);

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
      if (sendForcedStatus(req, res, shape)) return;
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
  entryPaths: ["/mcp"],
  revisions: [PROFILE_2025_11_25.revision as "2025-11-25"],
  createRouter: () => legacyRouter([PROFILE_2025_11_25]),
};
