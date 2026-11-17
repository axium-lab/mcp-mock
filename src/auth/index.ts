import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response, Router } from "express";
import { issue, s256, verify } from "./tokens.ts";

// OAuth for the protected endpoints (/protected/...), with the mock as both
// the MCP server (an OAuth resource server) and its own authorization
// server, on the same origin. Everything not under /protected stays open:
// authorization is opt-in by URL, so the zero-setup endpoints never change.
//
// The authorization server approves every request at once, without a login
// page, and stores nothing: codes and tokens are signed and self-contained.
// The cost is that an authorization code is not single-use, which a real
// server must enforce.

export const PROTECTED_PREFIX = "/protected";
// The one scope every protected endpoint requires.
export const REQUIRED_SCOPE = "mcp";
// Requested on authorize, this scope makes the user deny access.
export const DENY_SCOPE = "mcp-mock:deny";
const ACCESS_TTL_S = 3600;
const CODE_TTL_S = 60;
const PRM_PREFIX = "/.well-known/oauth-protected-resource";

function origin(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

const nowS = () => Math.floor(Date.now() / 1000);

// The canonical URI of the protected endpoint a request is for (RFC 8707),
// which tokens must be issued to. The 2024-11-05 transport is one resource
// across its two URLs.
function resourceOf(req: Request): string {
  const path = req.path.replace(/\/messages$/, "/sse");
  return `${origin(req)}${PROTECTED_PREFIX}${path}`;
}

function metadataUrl(req: Request): string {
  return `${origin(req)}${PRM_PREFIX}${PROTECTED_PREFIX}${req.path.replace(/\/messages$/, "/sse")}`;
}

function challenge(req: Request, res: Response, status: 401 | 403, error?: string, description?: string): void {
  const params = [
    ...(error ? [`error="${error}"`] : []),
    `scope="${REQUIRED_SCOPE}"`,
    `resource_metadata="${metadataUrl(req)}"`,
    ...(description ? [`error_description="${description}"`] : []),
  ];
  res.setHeader("WWW-Authenticate", `Bearer ${params.join(", ")}`);
  res.status(status).json({ error: error ?? "unauthorized", error_description: description ?? "Authorization required" });
}

// The resource server's check, in front of every protected endpoint: a
// bearer token in the Authorization header (never the query string), issued
// by this authorization server, unexpired, for this very endpoint, with the
// required scope.
export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return challenge(req, res, 401);
  const claims = verify(match[1] as string, "access");
  if (!claims) return challenge(req, res, 401, "invalid_token", "The access token is not valid");
  if (claims.exp <= nowS()) return challenge(req, res, 401, "invalid_token", "The access token has expired");
  if (claims.aud !== resourceOf(req)) {
    return challenge(req, res, 401, "invalid_token", "The access token was issued for another resource");
  }
  if (!claims.scope.split(" ").includes(REQUIRED_SCOPE)) {
    return challenge(req, res, 403, "insufficient_scope", `The "${REQUIRED_SCOPE}" scope is required`);
  }
  next();
}

function tokenError(res: Response, error: string, description: string, status = 400): void {
  res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });
}

function issueTokens(res: Response, clientId: string, scope: string, resource: string, ttl: number, refresh?: string): void {
  res
    .status(200)
    .set("Cache-Control", "no-store")
    .json({
      access_token: issue({ typ: "access", client_id: clientId, scope, aud: resource, exp: nowS() + ttl }),
      token_type: "Bearer",
      expires_in: ttl,
      refresh_token: refresh ?? issue({ typ: "refresh", client_id: clientId, scope, resource }),
      scope,
    });
}

function isAbsoluteUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function authRouter(): Router {
  const router = Router();

  // Authorization server metadata (RFC 8414), also served as OpenID Connect
  // discovery, since clients must support both.
  const asMetadata = (req: Request, res: Response) => {
    const base = origin(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [REQUIRED_SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  };
  router.get("/.well-known/oauth-authorization-server", asMetadata);
  router.get("/.well-known/openid-configuration", asMetadata);

  // Protected resource metadata (RFC 9728), one document per protected
  // endpoint, at the well-known path with the endpoint's path appended.
  router.use((req, res, next) => {
    if (req.method !== "GET" || !req.path.startsWith(`${PRM_PREFIX}${PROTECTED_PREFIX}/`)) return next();
    const path = req.path.slice(PRM_PREFIX.length);
    res.json({
      resource: `${origin(req)}${path}`,
      authorization_servers: [origin(req)],
      scopes_supported: [REQUIRED_SCOPE],
      bearer_methods_supported: ["header"],
    });
  });

  // The authorization endpoint approves at once and redirects back with a
  // code, or with an error when the request asks to be denied. Errors that
  // cannot be trusted to a redirect URI (a missing or malformed one) are
  // answered directly.
  router.get("/oauth/authorize", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (typeof q.client_id !== "string" || q.client_id === "") {
      return tokenError(res, "invalid_request", "client_id is required");
    }
    if (!isAbsoluteUrl(q.redirect_uri)) return tokenError(res, "invalid_request", "redirect_uri must be an absolute URL");

    const issuer = origin(req);
    const back = (params: Record<string, string>) => {
      const url = new URL(q.redirect_uri as string);
      for (const [key, value] of Object.entries({ ...params, ...(q.state ? { state: q.state } : {}), iss: issuer })) {
        url.searchParams.set(key, value);
      }
      res.redirect(302, url.toString());
    };
    const scope = q.scope?.trim() || REQUIRED_SCOPE;

    if (q.response_type !== "code") return back({ error: "unsupported_response_type", error_description: 'response_type must be "code"' });
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return back({ error: "invalid_request", error_description: "PKCE with code_challenge_method S256 is required" });
    }
    if (!isAbsoluteUrl(q.resource)) {
      return back({ error: "invalid_target", error_description: "resource must be the canonical URI of the MCP server" });
    }
    if (scope.split(" ").includes(DENY_SCOPE)) {
      return back({ error: "access_denied", error_description: "The user denied access" });
    }
    back({
      code: issue({
        typ: "code",
        client_id: q.client_id,
        redirect_uri: q.redirect_uri as string,
        code_challenge: q.code_challenge,
        scope,
        resource: q.resource,
        exp: nowS() + CODE_TTL_S,
      }),
    });
  });

  router.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    // mcp_mock_expires_in, a mock extension: issue tokens that expire when
    // a test wants them to, to exercise expiry and refresh.
    const ttl = body.mcp_mock_expires_in === undefined ? ACCESS_TTL_S : Number(body.mcp_mock_expires_in);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86_400) {
      return tokenError(res, "invalid_request", "mcp_mock_expires_in must be an integer number of seconds from 1 to 86400");
    }

    if (body.grant_type === "authorization_code") {
      const code = verify(body.code ?? "", "code");
      if (!code || code.exp <= nowS()) return tokenError(res, "invalid_grant", "The authorization code is invalid or expired");
      if (body.client_id !== code.client_id) return tokenError(res, "invalid_grant", "The code was issued to another client");
      if (body.redirect_uri !== code.redirect_uri) return tokenError(res, "invalid_grant", "redirect_uri does not match the authorization request");
      if (!body.code_verifier || s256(body.code_verifier) !== code.code_challenge) {
        return tokenError(res, "invalid_grant", "The code_verifier does not match the code_challenge");
      }
      if (body.resource !== undefined && body.resource !== code.resource) {
        return tokenError(res, "invalid_target", "resource does not match the authorization request");
      }
      return issueTokens(res, code.client_id, code.scope, code.resource, ttl);
    }

    if (body.grant_type === "refresh_token") {
      const refresh = verify(body.refresh_token ?? "", "refresh");
      if (!refresh) return tokenError(res, "invalid_grant", "The refresh token is invalid");
      if (body.client_id !== undefined && body.client_id !== refresh.client_id) {
        return tokenError(res, "invalid_grant", "The refresh token was issued to another client");
      }
      if (body.resource !== undefined && body.resource !== refresh.resource) {
        return tokenError(res, "invalid_target", "resource does not match the original grant");
      }
      return issueTokens(res, refresh.client_id, refresh.scope, refresh.resource, ttl, body.refresh_token);
    }

    tokenError(res, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  });

  // Dynamic Client Registration (RFC 7591), deprecated in 2026-07-28 in favour
  // of Client ID Metadata Documents but still used. The client id is derived
  // from the metadata, so the same client registers to the same id.
  router.post("/oauth/register", express.json(), (req, res) => {
    const metadata = (req.body ?? {}) as Record<string, unknown>;
    const uris = metadata.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isAbsoluteUrl)) {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must list absolute URLs" });
    }
    const clientId = `mcpmock_client_${createHash("sha256").update(JSON.stringify(metadata)).digest("hex").slice(0, 24)}`;
    res.status(201).json({ ...metadata, client_id: clientId, token_endpoint_auth_method: "none" });
  });

  return router;
}
