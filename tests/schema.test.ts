import { describe, expect, it } from "bun:test";
import { ErrorCode, errorResponse, parseMessage, successResponse } from "../src/core/jsonrpc.ts";
import { REVISIONS } from "../src/core/revisions.ts";
import { validateAgainst, validateMessage } from "./schema.ts";

// Proves the harness itself: every vendored schema loads, accepts what it
// should and rejects what it should. Endpoint tests rely on it from phase 1.
describe.each(REVISIONS.map(({ id }) => id))("schema %s", (revision) => {
  it("accepts a well-formed request and result", () => {
    expect(validateMessage(revision, { jsonrpc: "2.0", id: 1, method: "tools/list" }).valid).toBe(
      true,
    );
    // 2026-07-28 requires resultType on every result; older revisions accept
    // it as an unknown extra field.
    expect(validateMessage(revision, successResponse(1, { resultType: "complete" })).valid).toBe(
      true,
    );
  });

  it("accepts the error responses the core builds", () => {
    const methodNotFound = errorResponse(7, ErrorCode.MethodNotFound, "Method not found: x");
    expect(validateMessage(revision, methodNotFound)).toEqual({ valid: true, errors: [] });

    const invalid = parseMessage({ jsonrpc: "1.0", id: 7, method: "m" });
    if (invalid.kind !== "invalid") throw new Error("expected an invalid message");
    expect(validateMessage(revision, invalid.response).valid).toBe(true);
  });

  it("rejects a message without the jsonrpc marker", () => {
    const result = validateMessage(revision, { id: 1, method: "tools/list" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validates individual definitions", () => {
    expect(validateAgainst(revision, "ListToolsResult", { tools: [] }).valid).toBe(
      // 2026-07-28 made ttlMs and cacheScope mandatory on list results.
      revision !== "2026-07-28",
    );
  });
});

describe("revision differences the schemas encode", () => {
  it("only 2026-07-28 requires resultType on results", () => {
    const bare = successResponse(1, {});
    expect(validateMessage("2026-07-28", bare).valid).toBe(false);
    expect(validateMessage("2025-11-25", bare).valid).toBe(true);
  });

  it("only 2026-07-28 defines server/discover", () => {
    expect(() => validateAgainst("2026-07-28", "DiscoverResult", {})).not.toThrow();
    expect(() => validateAgainst("2025-11-25", "DiscoverResult", {})).toThrow();
  });

  it("only 2026-07-28 requires the cache hints on tools/list", () => {
    const cached = { tools: [], ttlMs: 0, cacheScope: "public", resultType: "complete" };
    expect(validateAgainst("2026-07-28", "ListToolsResult", cached).valid).toBe(true);
  });
});
