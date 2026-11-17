import express, { type Express, Router } from "express";
import { authRouter, PROTECTED_PREFIX, requireToken } from "./auth/index.ts";
import { errorHandler, notFoundHandler } from "./core/errors.ts";
import { SERVER_INFO } from "./core/server-info.ts";
import { endpoints } from "./endpoints/index.ts";

// Builds the Express app without calling listen(), so tests can mount it on an
// ephemeral port and point the official MCP clients at it.
export function createApp(): Express {
  const app = express();
  // OAuth redirects and metadata URLs are built from the request's origin.
  app.set("trust proxy", true);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: SERVER_INFO.version });
  });

  // The authorization server and the protected resource metadata.
  app.use(authRouter());

  // Every endpoint again under /protected, behind a bearer token. Mounted
  // before the open ones so the dual-era endpoint at the root does not
  // shadow it.
  const protectedEndpoints = Router();
  protectedEndpoints.use(requireToken);
  for (const endpoint of endpoints) {
    protectedEndpoints.use(endpoint.mountPath || "/", endpoint.createRouter());
  }
  app.use(PROTECTED_PREFIX, protectedEndpoints);

  for (const endpoint of endpoints) {
    app.use(endpoint.mountPath || "/", endpoint.createRouter());
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
