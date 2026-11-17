import { describe, expect, it } from "bun:test";
import { CONTROL, forcedResult, forcedStatus, withControl } from "../../src/core/control.ts";
import { ErrorCode, JsonRpcError } from "../../src/core/jsonrpc.ts";

const withResponse = (value: unknown) => ({ name: "any", _meta: { [CONTROL.response]: value } });

describe("forcedResult", () => {
  it("is undefined when nothing is forced", () => {
    expect(forcedResult({ name: "echo" })).toBeUndefined();
    expect(forcedResult(undefined)).toBeUndefined();
  });

  it("turns text into a single text block", () => {
    expect(forcedResult(withResponse({ text: "hi" }))).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("passes content blocks through as given", () => {
    const content = [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }];
    expect(forcedResult(withResponse({ content, isError: true }))).toEqual({ content, isError: true });
  });

  it("repeats structured content as JSON text when no content is given", () => {
    expect(forcedResult(withResponse({ structuredContent: { temperature: 40 } }))).toEqual({
      content: [{ type: "text", text: '{"temperature":40}' }],
      structuredContent: { temperature: 40 },
    });
  });

  it.each([
    ["a non-object", "hi", "expected an object"],
    ["an empty object", {}, 'at least one of "text", "content" or "structuredContent"'],
    ["both text and content", { text: "a", content: [] }, 'either "text" or "content"'],
    ["content blocks without a type", { content: [{ text: "a" }] }, '"content" must be an array'],
    ["non-object structured content", { structuredContent: [1] }, '"structuredContent" must be an object'],
    ["a non-boolean isError", { text: "a", isError: "yes" }, '"isError" must be a boolean'],
    ["an unknown field", { text: "a", status: 200 }, "unknown field(s): status"],
  ])("rejects %s as invalid params", (_case, value, message) => {
    try {
      forcedResult(withResponse(value));
      throw new Error("expected a JsonRpcError");
    } catch (error) {
      expect(error).toBeInstanceOf(JsonRpcError);
      expect((error as JsonRpcError).code).toBe(ErrorCode.InvalidParams);
      expect((error as JsonRpcError).message).toContain(message);
    }
  });
});

describe("withControl", () => {
  const handlers = withControl({ requests: { ping: () => ({ pong: true }) } });
  const ping = handlers.requests.ping as (params: Record<string, unknown> | undefined, context: unknown) => unknown;

  it("leaves requests that force nothing alone", () => {
    expect(ping(undefined, {})).toEqual({ pong: true });
  });

  it("throws the forced error, data included", () => {
    try {
      ping({ _meta: { [CONTROL.error]: { code: -32603, message: "boom", data: { retry: false } } } }, {});
      throw new Error("expected a JsonRpcError");
    } catch (error) {
      expect((error as JsonRpcError).toObject()).toEqual({ code: -32603, message: "boom", data: { retry: false } });
    }
  });

  it("refuses a malformed forced error", () => {
    expect(() => ping({ _meta: { [CONTROL.error]: { code: 1.5, message: "x" } } }, {})).toThrow('"code" must be an integer');
    expect(() => ping({ _meta: { [CONTROL.error]: { code: 1 } } }, {})).toThrow('"message" must be a string');
  });
});

describe("forcedStatus", () => {
  it("is undefined without the header", () => {
    expect(forcedStatus(undefined)).toBeUndefined();
  });

  it("forces any status from 400 to 599", () => {
    expect(forcedStatus("503")).toMatchObject({ status: 503, headers: {} });
    expect(forcedStatus(" 418 ")).toMatchObject({ status: 418 });
  });

  it("adds Retry-After to 429", () => {
    expect(forcedStatus("429")).toMatchObject({ status: 429, headers: { "Retry-After": "1" } });
  });

  it.each(["200", "302", "600", "abc", ""])("refuses %p with a 400 that names the header", (value) => {
    const forced = forcedStatus(value);
    expect(forced?.status).toBe(400);
    expect(forced?.message).toContain(CONTROL.statusHeader);
  });
});
