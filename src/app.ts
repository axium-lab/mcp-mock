import express, { type Express } from "express";
import { errorHandler, notFoundHandler } from "./core/errors.ts";
import { SERVER_INFO } from "./core/server-info.ts";
import { endpoints } from "./endpoints/index.ts";

// Builds the Express app without calling listen(), so tests can mount it on an
// ephemeral port and point the official MCP clients at it.
export function createApp(): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: SERVER_INFO.version });
  });

  for (const endpoint of endpoints) {
    app.use(endpoint.mountPath || "/", endpoint.createRouter());
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
