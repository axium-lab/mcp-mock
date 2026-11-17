import express, { type Express } from "express";
import pkg from "../package.json" with { type: "json" };
import { errorHandler, notFoundHandler } from "./core/errors.ts";
import { endpoints } from "./endpoints/index.ts";

// Builds the Express app without calling listen(), so tests can mount it on an
// ephemeral port and point the official MCP clients at it.
export function createApp(): Express {
  const app = express();

  // The version is read from package.json so a running container can be
  // matched against the release it was built from.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: pkg.version });
  });

  for (const endpoint of endpoints) {
    app.use(endpoint.mountPath || "/", endpoint.createRouter());
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
