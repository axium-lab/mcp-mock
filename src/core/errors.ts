import type { NextFunction, Request, Response } from "express";

// HTTP-level fallbacks for requests outside any MCP endpoint (/health, unknown
// paths, bodies Express itself rejects). They answer with plain JSON, not a
// JSON-RPC envelope: no MCP endpoint was reached, so there is no protocol to
// speak. Each endpoint turns its own failures into JSON-RPC errors.
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { message: `Unknown request URL: ${req.method} ${req.path}` } });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: { message } });
}
