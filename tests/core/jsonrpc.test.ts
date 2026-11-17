import { describe, expect, it } from "bun:test";
import {
  dispatch,
  ErrorCode,
  type Handlers,
  JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  parseJson,
  parseMessage,
} from "../../src/core/jsonrpc.ts";

const request = (method: string, params?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});

describe("parseJson", () => {
  it("answers a syntax error with a parse error and a null id", () => {
    const parsed = parseJson("{not json");
    expect(parsed).toEqual({
      ok: false,
      response: {
        jsonrpc: "2.0",
        id: null,
        error: { code: ErrorCode.ParseError, message: "Parse error" },
      },
    });
  });
});

describe("parseMessage", () => {
  it("classifies requests, notifications and responses", () => {
    expect(parseMessage({ jsonrpc: "2.0", id: "a", method: "tools/list" }).kind).toBe("request");
    expect(parseMessage({ jsonrpc: "2.0", method: "notifications/initialized" }).kind).toBe(
      "notification",
    );
    expect(parseMessage({ jsonrpc: "2.0", id: 3, result: {} }).kind).toBe("response");
    expect(parseMessage({ jsonrpc: "2.0", id: 3, error: { code: 1, message: "x" } }).kind).toBe(
      "response",
    );
  });

  it("keeps params when present and omits them when absent", () => {
    const withParams = parseMessage({ jsonrpc: "2.0", id: 1, method: "m", params: { a: 1 } });
    expect(withParams).toEqual({
      kind: "request",
      message: { jsonrpc: "2.0", id: 1, method: "m", params: { a: 1 } },
    });
    const without = parseMessage({ jsonrpc: "2.0", id: 1, method: "m" });
    expect(without).toEqual({ kind: "request", message: { jsonrpc: "2.0", id: 1, method: "m" } });
  });

  it.each([
    ["a non-object", [1, 2], null],
    ["a missing jsonrpc", { id: 1, method: "m" }, 1],
    ["a wrong jsonrpc", { jsonrpc: "1.0", id: 1, method: "m" }, 1],
    ["a null id", { jsonrpc: "2.0", id: null, method: "m" }, null],
    ["a fractional id", { jsonrpc: "2.0", id: 1.5, method: "m" }, null],
    ["a non-string method", { jsonrpc: "2.0", id: 1, method: 7 }, 1],
    ["array params", { jsonrpc: "2.0", id: 1, method: "m", params: [1] }, 1],
    ["result and error together", { jsonrpc: "2.0", id: 1, result: {}, error: {} }, 1],
    ["a malformed error", { jsonrpc: "2.0", id: 1, error: { code: "x" } }, 1],
    ["no method, result or error", { jsonrpc: "2.0", id: 1 }, 1],
  ])("rejects %s as Invalid Request, echoing the id it could read", (_name, value, id) => {
    const parsed = parseMessage(value);
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind !== "invalid") return;
    expect(parsed.response.id).toBe(id);
    expect(parsed.response.error.code).toBe(ErrorCode.InvalidRequest);
  });
});

describe("dispatch", () => {
  const seen: string[] = [];
  const handlers: Handlers<{ user: string }> = {
    requests: {
      echo: (params, context) => ({ params: params ?? null, user: context.user }),
      fail: () => {
        throw new JsonRpcError(ErrorCode.InvalidParams, "bad params", { field: "x" });
      },
      crash: () => {
        throw new Error("boom");
      },
      slow: async () => ({ done: true }),
    },
    notifications: {
      "notifications/seen": (params) => {
        seen.push(String(params?.name));
      },
    },
  };
  const context = { user: "test" };

  it("returns the handler's result with the request id", async () => {
    expect(await dispatch(request("echo", { a: 1 }), handlers, context)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { params: { a: 1 }, user: "test" },
    });
    expect(await dispatch(request("slow"), handlers, context)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { done: true },
    });
  });

  it("answers an unknown method with Method not found", async () => {
    const response = await dispatch(request("tools/nope"), handlers, context);
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: ErrorCode.MethodNotFound, message: "Method not found: tools/nope" },
    });
  });

  it("does not resolve methods through the prototype chain", async () => {
    const response = await dispatch(request("toString"), handlers, context);
    expect(response && "error" in response && response.error.code).toBe(ErrorCode.MethodNotFound);
  });

  it("serializes a JsonRpcError thrown by the handler, data included", async () => {
    expect(await dispatch(request("fail"), handlers, context)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: ErrorCode.InvalidParams, message: "bad params", data: { field: "x" } },
    });
  });

  it("turns any other exception into an internal error", async () => {
    const response = await dispatch(request("crash"), handlers, context);
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: ErrorCode.InternalError, message: "Internal error: boom" },
    });
  });

  it("runs notification handlers and never answers a notification", async () => {
    const known: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/seen",
      params: { name: "a" },
    };
    const unknown: JsonRpcNotification = { jsonrpc: "2.0", method: "notifications/unknown" };
    expect(await dispatch(known, handlers, context)).toBeUndefined();
    expect(await dispatch(unknown, handlers, context)).toBeUndefined();
    expect(seen).toEqual(["a"]);
  });
});
