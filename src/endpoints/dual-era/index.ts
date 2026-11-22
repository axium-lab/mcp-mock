import express, { type Request, type Response, Router } from "express";
import { parseJson } from "../../core/jsonrpc.ts";
import { PROFILE_2024_11_05, sseRouter } from "../2024-11-05/index.ts";
import { PROFILE_2025_03_26 } from "../2025-03-26/index.ts";
import { PROFILE_2025_06_18 } from "../2025-06-18/index.ts";
import { defaultProfile, serveLegacy } from "../2025-11-25/index.ts";
import { PROFILE_2025_11_25, shapeFor } from "../2025-11-25/profile.ts";
import { hasClaim } from "../2026-07-28/envelope.ts";
import {
  bodyErrorHandler,
  checkPostHeaders,
  type ErrorShape,
  methodNotAllowedWith,
  send,
  sendForcedStatus,
} from "../2026-07-28/http.ts";
import { MODERN_VERSIONS, serveModern } from "../2026-07-28/index.ts";
import type { Endpoint } from "../types.ts";

// The legacy revisions /mcp serves, newest first: initialize negotiates among
// them, later requests are served as the one their header names, and a
// request without the header as 2025-03-26, as the spec prescribes.
const LEGACY_PROFILES = [PROFILE_2025_11_25, PROFILE_2025_06_18, PROFILE_2025_03_26];

// /mcp serves every client, whatever era it speaks, the way the spec
// describes a dual-era server: the era is read from how each request opens,
// never remembered.
//
// - Modern: the request carries the per-request envelope (_meta with a
//   protocol version), or its MCP-Protocol-Version header names a modern
//   revision. Served statelessly as that revision; a modern header without
//   the envelope is the modern leg's -32602 to give, not a reason to fall back.
// - Legacy: everything else, initialize included. Served as the negotiated
//   legacy revision.
//
// Each leg advertises only its own era's versions: a modern client told it
// could use 2025-11-25 would retry with it in _meta, which no legacy revision
// understands.
function hasModernEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const params = (value as { params?: unknown }).params;
  return (
    typeof params === "object" &&
    params !== null &&
    !Array.isArray(params) &&
    hasClaim(params as Record<string, unknown>)
  );
}

function isModern(body: unknown, headerVersion: string | undefined): boolean {
  if (headerVersion !== undefined && (MODERN_VERSIONS as readonly string[]).includes(headerVersion)) {
    return true;
  }
  // A batch carrying any modern-enveloped element belongs to the modern leg
  // (which rejects batches) rather than silently falling back to 2025-03-26.
  if (Array.isArray(body)) return body.some(hasModernEnvelope);
  return hasModernEnvelope(body);
}

// Errors raised before the body says which era it is (transport refusals,
// malformed JSON) take the shape of the legacy revision the header names, or
// of 2025-03-26 when there is no header (only its clients omit it); a modern
// or unknown header gets the modern shape, which 2025-11-25 shares.
function shapeForHeader(req: Request): ErrorShape | undefined {
  const headerVersion = req.get("mcp-protocol-version")?.trim();
  const profile =
    headerVersion === undefined
      ? defaultProfile(LEGACY_PROFILES)
      : LEGACY_PROFILES.find((candidate) => candidate.revision === headerVersion);
  return profile ? shapeFor(profile) : undefined;
}

async function handlePost(req: Request, res: Response): Promise<void> {
  const refused = checkPostHeaders(req);
  if (refused) return send(res, refused, shapeForHeader(req));
  if (sendForcedStatus(req, res, shapeForHeader(req))) return;

  const json = parseJson(typeof req.body === "string" ? req.body : "");
  if (!json.ok) return send(res, { status: 400, body: json.response }, shapeForHeader(req));

  const headerVersion = req.get("mcp-protocol-version")?.trim();
  if (isModern(json.value, headerVersion)) return serveModern(json.value, req, res);
  return serveLegacy(json.value, req, res, LEGACY_PROFILES);
}

function methodNotAllowed(req: Request, res: Response): void {
  methodNotAllowedWith(shapeForHeader(req) ?? ((body) => body))(req, res);
}

export const dualEraEndpoint: Endpoint = {
  name: "dual-era",
  mountPath: "",
  entryPaths: ["/mcp", "/sse"],
  revisions: [...MODERN_VERSIONS, "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
  createRouter() {
    const router = Router();
    router.use("/mcp", express.text({ type: () => true, limit: "4mb" }));
    router.post("/mcp", (req, res, next) => {
      handlePost(req, res).catch(next);
    });
    // Neither era has a GET stream or a session to end here.
    router.all("/mcp", methodNotAllowed);
    router.use("/mcp", bodyErrorHandler);
    // The deprecated HTTP+SSE transport, hosted next to the MCP endpoint as
    // the spec suggests for servers that keep serving 2024-11-05 clients.
    // Over it, initialize may negotiate any legacy revision.
    router.use(sseRouter([...LEGACY_PROFILES, PROFILE_2024_11_05]));
    return router;
  },
};
