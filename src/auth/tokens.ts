import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Self-contained credentials for the mock's authorization server: codes,
// access tokens and refresh tokens carry everything needed to check them,
// signed with HMAC, so nothing is stored. The key is fixed and public: this
// is a test double, and a fixed key keeps tokens valid across restarts.
// Never point a real client with real users at it.
const KEY = "mcp-mock: not a secret";

export interface CodeClaims {
  typ: "code";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  exp: number;
}

export interface AccessClaims {
  typ: "access";
  client_id: string;
  scope: string;
  aud: string;
  exp: number;
}

export interface RefreshClaims {
  typ: "refresh";
  client_id: string;
  scope: string;
  resource: string;
}

export type Claims = CodeClaims | AccessClaims | RefreshClaims;

const PREFIX: Record<Claims["typ"], string> = { code: "mcpmock_code", access: "mcpmock_at", refresh: "mcpmock_rt" };

function sign(data: string): string {
  return createHmac("sha256", KEY).update(data).digest("base64url");
}

export function issue(claims: Claims): string {
  const body = `${PREFIX[claims.typ]}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${sign(body)}`;
}

// The claims of a credential of the expected type, if its signature holds.
// Expiry is the caller's to check, since what an expired credential means
// depends on where it is presented.
export function verify<T extends Claims["typ"]>(token: string, typ: T): Extract<Claims, { typ: T }> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX[typ]) return undefined;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2] as string);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as Claims;
    return claims.typ === typ ? (claims as Extract<Claims, { typ: T }>) : undefined;
  } catch {
    return undefined;
  }
}

// PKCE S256: BASE64URL(SHA256(code_verifier)).
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
