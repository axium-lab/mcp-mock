import type { Router } from "express";
import type { RevisionId } from "../core/revisions.ts";

// An endpoint is a self-contained router: one per pinned spec revision
// (/2026-07-28/mcp, /2025-11-25/mcp, ...) plus the dual-era /mcp. It owns its
// paths, its transport and its revision's quirks, so adding an endpoint never
// touches another one. When a revision did not change something, its endpoint
// imports the newer one's code for it instead of copying it.
export interface Endpoint {
  // "2026-07-28", ..., or "dual-era" for /mcp.
  name: string;
  // Where the router is mounted: "/2026-07-28" for a pinned revision, "" for
  // the dual-era endpoint at the root.
  mountPath: string;
  // The URLs a client connects to, relative to mountPath: "/mcp" for
  // Streamable HTTP, "/sse" for the 2024-11-05 transport.
  entryPaths: readonly string[];
  // The revisions this endpoint answers with, newest first.
  revisions: readonly RevisionId[];
  createRouter(): Router;
}
