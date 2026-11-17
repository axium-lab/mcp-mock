import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { type RunningServer, startServer, stopServer } from "../server.ts";

// OAuth on the protected endpoints: the official SDK runs the whole flow
// (discovery, registration, PKCE, token, refresh) against the mock as both
// resource server and authorization server, and the failure paths are
// checked on the wire.
describe("OAuth on /protected", () => {
  let running: RunningServer;
  beforeAll(async () => {
    running = await startServer();
  });
  afterAll(() => stopServer(running.server));

  const REDIRECT = "http://localhost:9999/callback";

  // An in-memory OAuth client for the SDK. The "browser" follows the
  // authorization URL without following the redirect, and keeps the code.
  function provider() {
    let client: Record<string, unknown> | undefined;
    let tokens: Record<string, unknown> | undefined;
    let verifier = "";
    const state = { code: "", iss: "" };
    return {
      state,
      get tokens() {
        return tokens;
      },
      impl: {
        get redirectUrl() {
          return REDIRECT;
        },
        get clientMetadata() {
          return { client_name: "mcp-mock tests", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" };
        },
        clientInformation: () => client,
        saveClientInformation: (info: Record<string, unknown>) => {
          client = info;
        },
        tokens: () => tokens,
        saveTokens: (saved: Record<string, unknown>) => {
          tokens = saved;
        },
        redirectToAuthorization: async (url: URL) => {
          const res = await fetch(url, { redirect: "manual" });
          const location = new URL(res.headers.get("location") as string);
          state.code = location.searchParams.get("code") ?? "";
          state.iss = location.searchParams.get("iss") ?? "";
        },
        saveCodeVerifier: (value: string) => {
          verifier = value;
        },
        codeVerifier: () => verifier,
      },
    };
  }

  describe("through the official SDK", () => {
    it.each([
      ["2026-07-28", { mode: { pin: "2026-07-28" } } as const],
      ["legacy", { mode: "legacy" } as const],
    ])("authorizes and then serves the protected /mcp (%s)", async (_era, negotiation) => {
      const url = new URL(`${running.origin}/protected/mcp`);
      const oauth = provider();
      const first = new Client({ name: "t", version: "0" }, { versionNegotiation: negotiation });
      await expect(first.connect(new StreamableHTTPClientTransport(url, { authProvider: oauth.impl as never }))).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
      expect(oauth.state.code).toMatch(/^mcpmock_code\./);
      expect(oauth.state.iss).toBe(running.origin);

      const transport = new StreamableHTTPClientTransport(url, { authProvider: oauth.impl as never });
      await transport.finishAuth(oauth.state.code, oauth.state.iss);
      expect(oauth.tokens).toMatchObject({ token_type: "Bearer", scope: "mcp" });

      const client = new Client({ name: "t", version: "0" }, { versionNegotiation: negotiation });
      await client.connect(new StreamableHTTPClientTransport(url, { authProvider: oauth.impl as never }));
      const result = await client.callTool({ name: "echo", arguments: { text: "authorized" } });
      expect(result.content).toEqual([{ type: "text", text: "Echo: authorized" }]);
      await client.close();
    });
  });

  describe("on the wire", () => {
    const pkce = () => {
      const verifier = randomBytes(32).toString("base64url");
      return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
    };
    const resource = () => `${running.origin}/protected/mcp`;

    async function authorize(params: Record<string, string>) {
      const url = new URL(`${running.origin}/oauth/authorize`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const res = await fetch(url, { redirect: "manual" });
      return { status: res.status, location: res.headers.get("location") ? new URL(res.headers.get("location") as string) : undefined, res };
    }
    async function token(form: Record<string, string>) {
      const res = await fetch(`${running.origin}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      });
      return { status: res.status, body: (await res.json()) as any };
    }
    async function accessToken(options: { scope?: string; resource?: string; expiresIn?: string } = {}) {
      const { verifier, challenge } = pkce();
      const { location } = await authorize({
        response_type: "code",
        client_id: "client-1",
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: options.resource ?? resource(),
        ...(options.scope ? { scope: options.scope } : {}),
      });
      const issued = await token({
        grant_type: "authorization_code",
        code: location?.searchParams.get("code") as string,
        client_id: "client-1",
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: options.resource ?? resource(),
        ...(options.expiresIn ? { mcp_mock_expires_in: options.expiresIn } : {}),
      });
      return issued.body;
    }
    const ping = (path: string, bearer?: string) =>
      fetch(`${running.origin}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });

    it("leaves the open endpoints open", async () => {
      expect((await ping("/mcp")).status).toBe(200);
    });

    it("challenges a request without a token with 401 and where to find the metadata", async () => {
      const res = await ping("/protected/mcp");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        `Bearer scope="mcp", resource_metadata="${running.origin}/.well-known/oauth-protected-resource/protected/mcp"`,
      );
    });

    it("serves protected resource metadata per endpoint", async () => {
      const prm = (await (await fetch(`${running.origin}/.well-known/oauth-protected-resource/protected/2026-07-28/mcp`)).json()) as Record<string, unknown>;
      expect(prm).toEqual({
        resource: `${running.origin}/protected/2026-07-28/mcp`,
        authorization_servers: [running.origin],
        scopes_supported: ["mcp"],
        bearer_methods_supported: ["header"],
      });
    });

    it.each(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"])("serves authorization server metadata at %s", async (path) => {
      const metadata = (await (await fetch(`${running.origin}${path}`)).json()) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        issuer: running.origin,
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      });
    });

    it("issues a token that opens the protected endpoint it was issued for, and only that one", async () => {
      const issued = await accessToken();
      expect(issued).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
      expect((await ping("/protected/mcp", issued.access_token)).status).toBe(200);
      const other = await ping("/protected/2025-11-25/mcp", issued.access_token);
      expect(other.status).toBe(401);
      expect(other.headers.get("www-authenticate")).toContain('error="invalid_token"');
    });

    it("answers a token without the required scope with 403 insufficient_scope", async () => {
      const issued = await accessToken({ scope: "something-else" });
      const res = await ping("/protected/mcp", issued.access_token);
      expect(res.status).toBe(403);
      expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      expect(res.headers.get("www-authenticate")).toContain('scope="mcp"');
    });

    it("rejects an expired token and refreshes it", async () => {
      const issued = await accessToken({ expiresIn: "1" });
      await Bun.sleep(1100);
      const expired = await ping("/protected/mcp", issued.access_token);
      expect(expired.status).toBe(401);
      expect(expired.headers.get("www-authenticate")).toContain("expired");

      const refreshed = await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: "client-1" });
      expect((await ping("/protected/mcp", refreshed.body.access_token)).status).toBe(200);
    });

    it("rejects tokens that are forged, or sent in the query string", async () => {
      expect((await ping("/protected/mcp", "mcpmock_at.e30.forged")).status).toBe(401);
      const issued = await accessToken();
      expect((await ping(`/protected/mcp?access_token=${issued.access_token}`)).status).toBe(401);
    });

    it("protects the 2024-11-05 transport too", async () => {
      expect((await fetch(`${running.origin}/protected/2024-11-05/sse`)).status).toBe(401);
    });

    describe("authorization errors", () => {
      const base = () => {
        const { challenge } = pkce();
        return { response_type: "code", client_id: "c", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: resource(), state: "s-1" };
      };

      it.each([
        ["a denied consent", { scope: "mcp mcp-mock:deny" }, "access_denied"],
        ["a missing resource", { resource: "" }, "invalid_target"],
        ["a plain PKCE challenge", { code_challenge_method: "plain" }, "invalid_request"],
        ["another response type", { response_type: "token" }, "unsupported_response_type"],
      ])("redirects %s back with the error, state and iss", async (_case, override, error) => {
        const params = Object.fromEntries(Object.entries({ ...base(), ...override }).filter(([, value]) => value !== ""));
        const { status, location } = await authorize(params as Record<string, string>);
        expect(status).toBe(302);
        expect(location?.searchParams.get("error")).toBe(error);
        expect(location?.searchParams.get("state")).toBe("s-1");
        expect(location?.searchParams.get("iss")).toBe(running.origin);
      });

      it("answers directly when there is no redirect URI to trust", async () => {
        const { res } = await authorize({ ...base(), redirect_uri: "not a url" });
        expect(res.status).toBe(400);
      });
    });

    describe("token errors", () => {
      async function code(challenge: string) {
        const { location } = await authorize({
          response_type: "code",
          client_id: "client-1",
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: resource(),
        });
        return location?.searchParams.get("code") as string;
      }

      it.each([
        ["a wrong code_verifier", { code_verifier: "wrong" }],
        ["another redirect_uri", { redirect_uri: "http://localhost:9999/other" }],
        ["another client", { client_id: "client-2" }],
        ["a forged code", { code: "mcpmock_code.e30.forged" }],
      ])("refuses %s with invalid_grant", async (_case, override) => {
        const { verifier, challenge } = pkce();
        const reply = await token({
          grant_type: "authorization_code",
          code: await code(challenge),
          client_id: "client-1",
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          ...override,
        });
        expect(reply.status).toBe(400);
        expect(reply.body.error).toBe("invalid_grant");
      });

      it("refuses another resource with invalid_target", async () => {
        const { verifier, challenge } = pkce();
        const reply = await token({
          grant_type: "authorization_code",
          code: await code(challenge),
          client_id: "client-1",
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: `${running.origin}/protected/2025-11-25/mcp`,
        });
        expect(reply.body.error).toBe("invalid_target");
      });

      it("refuses an unknown grant type", async () => {
        expect((await token({ grant_type: "password" })).body.error).toBe("unsupported_grant_type");
      });
    });

    describe("dynamic client registration", () => {
      it("registers a client to a stable id", async () => {
        const register = () =>
          fetch(`${running.origin}/oauth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ client_name: "app", redirect_uris: [REDIRECT], application_type: "native" }),
          }).then(async (res) => ({ status: res.status, body: (await res.json()) as any }));
        const first = await register();
        expect(first.status).toBe(201);
        expect(first.body).toMatchObject({ client_name: "app", token_endpoint_auth_method: "none" });
        expect(first.body.client_id).toMatch(/^mcpmock_client_/);
        expect((await register()).body.client_id).toBe(first.body.client_id);
      });

      it("refuses metadata without redirect URIs", async () => {
        const res = await fetch(`${running.origin}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_name: "app" }),
        });
        expect(res.status).toBe(400);
      });
    });
  });
});
