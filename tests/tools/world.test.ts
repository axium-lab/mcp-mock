import { describe, expect, it } from "bun:test";
import { callTool } from "../../src/tools/index.ts";
import type { ToolResult } from "../../src/tools/types.ts";

// The fake world: deterministic per argument, normalized, internally
// consistent, and failing only on the documented reserved values.
const call = (name: string, args: Record<string, unknown>): ToolResult => callTool({ name, arguments: args });
// Arbitrary structured data: each test asserts the fields it expects.
const data = (name: string, args: Record<string, unknown>) => call(name, args).structuredContent as any;

describe("determinism and normalization", () => {
  it.each([
    ["get_weather", { city: "Madrid" }, { city: "  mADRid " }],
    ["get_forecast", { city: "New York", days: 2 }, { city: "new   york", days: 2 }],
    ["search_web", { query: "MCP Mock" }, { query: " mcp mock" }],
    ["get_stock_price", { symbol: "ACME" }, { symbol: " acme " }],
    ["geocode", { address: "Gran Vía 1" }, { address: "gran vía 1" }],
    ["get_flight_status", { flight_number: "IB3456" }, { flight_number: "ib3456" }],
    ["send_email", { to: "Ada@Example.com", subject: "s", body: "b" }, { to: " ada@example.com", subject: "s", body: "b" }],
  ])("%s answers the same for equivalent arguments", (name, a, b) => {
    expect(call(name, a)).toEqual(call(name, b));
    expect(call(name, a).isError).toBeUndefined();
  });

  it("answers differently for different arguments", () => {
    expect(data("get_weather", { city: "Madrid" })).not.toEqual(data("get_weather", { city: "Oslo" }));
    expect(data("get_user", { user_id: "u_1" })).not.toEqual(data("get_user", { user_id: "u_2" }));
  });

  it("keeps user ids case-sensitive", () => {
    expect(data("get_user", { user_id: "Abc" })).not.toEqual(data("get_user", { user_id: "abc" }));
  });
});

describe("internal consistency", () => {
  it("reports the same weather in both unit systems", () => {
    const metric = data("get_weather", { city: "Lima" });
    const imperial = data("get_weather", { city: "Lima", units: "imperial" });
    expect(imperial.temperature).toBe(Math.round((metric.temperature * 9) / 5 * 10 + 320) / 10);
    expect(imperial.temperature_unit).toBe("°F");
    expect(imperial.conditions).toBe(metric.conditions);
    expect(imperial.humidity).toBe(metric.humidity);
  });

  it("only snows when it is cold enough", () => {
    for (const city of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p"]) {
      const weather = data("get_weather", { city });
      if (weather.conditions === "snow") expect(weather.temperature).toBeLessThanOrEqual(2);
    }
  });

  it("returns a shorter forecast as a prefix of a longer one", () => {
    const week = data("get_forecast", { city: "Oslo", days: 7 });
    const three = data("get_forecast", { city: "Oslo", days: 3 });
    expect(three.days).toEqual(week.days.slice(0, 3));
    for (const day of week.days) expect(day.low).toBeLessThan(day.high);
  });

  it("returns fewer search results as a prefix of more", () => {
    const ten = call("search_web", { query: "mcp", limit: 10 });
    const two = call("search_web", { query: "mcp", limit: 2 });
    expect((two.structuredContent as any).results).toEqual((ten.structuredContent as any).results.slice(0, 2));
    // One text block plus one resource_link per result.
    expect(two.content.map((block) => block.type)).toEqual(["text", "resource_link", "resource_link"]);
  });

  it("converts currencies consistently in both directions", () => {
    const there = data("convert_currency", { amount: 100, from: "EUR", to: "JPY" });
    const back = data("convert_currency", { amount: there.result, from: "JPY", to: "EUR" });
    expect(Math.abs(back.result - 100)).toBeLessThan(0.05);
    expect(data("convert_currency", { amount: 5, from: "USD", to: "usd" })).toMatchObject({ rate: 1, result: 5 });
  });

  it("reports a stock change consistent with its percentage", () => {
    const stock = data("get_stock_price", { symbol: "ACME" });
    expect(stock.change).toBeCloseTo((stock.price * stock.change_percent) / 100, 2);
  });

  it("gives flight fields that match the status", () => {
    for (const flight_number of ["IB1", "IB2", "IB3", "IB4", "IB5", "IB6", "IB7", "IB8", "IB9", "IB10"]) {
      const flight = data("get_flight_status", { flight_number });
      expect(flight.departure_airport).not.toBe(flight.arrival_airport);
      expect("delay_minutes" in flight).toBe(flight.status === "delayed");
      expect("gate" in flight).toBe(flight.status !== "cancelled");
    }
  });

  it("derives the message id from the whole message", () => {
    const one = data("send_email", { to: "a@example.com", subject: "s", body: "1" });
    const two = data("send_email", { to: "a@example.com", subject: "s", body: "2" });
    expect(one.message_id).toMatch(/^msg_[0-9a-f]{24}$/);
    expect(one.message_id).not.toBe(two.message_id);
  });

  it("embeds file contents that follow the extension", () => {
    const json = call("read_file", { path: "/app/config.json" }).content[0] as any;
    expect(json.resource.mimeType).toBe("application/json");
    expect(json.resource.uri).toBe("file:///app/config.json");
    expect(() => JSON.parse(json.resource.text)).not.toThrow();
    const csv = call("read_file", { path: "data.csv" }).content[0] as any;
    expect(csv.resource.uri).toBe("file:///data.csv");
    expect(csv.resource.text.startsWith("id,name,score\n")).toBe(true);
  });
});

describe("reserved values", () => {
  it.each([
    ["get_weather", { city: " ATLANTIS " }, "City not found: Atlantis"],
    ["get_forecast", { city: "Atlantis", days: 2 }, "City not found: Atlantis"],
    ["geocode", { address: "atlantis" }, "Address not found: Atlantis"],
    ["search_web", { query: "Error" }, "Search failed"],
    ["get_stock_price", { symbol: "xxxx" }, "Unknown symbol: XXXX"],
    ["convert_currency", { amount: 1, from: "USD", to: "xxx" }, "Unsupported currency: XXX"],
    ["get_user", { user_id: "missing" }, "User not found: missing"],
    ["get_flight_status", { flight_number: "xx000" }, "Flight not found: XX000"],
    ["read_file", { path: "/missing" }, "File not found: /missing"],
    ["send_email", { to: "Bounce@Example.com", subject: "s", body: "b" }, "Delivery failed"],
  ])("%s fails on its reserved value", (name, args, message) => {
    const result = call(name, args);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(message);
  });

  it("refuses paths that leave the root", () => {
    const result = call("read_file", { path: "/app/../etc/passwd" });
    expect(result.isError).toBe(true);
  });

  it("validates argument shapes as tool execution errors", () => {
    expect(call("get_forecast", { city: "Oslo", days: 30 }).isError).toBe(true);
    expect(call("get_stock_price", { symbol: "TOOLONG" }).isError).toBe(true);
    expect(call("get_flight_status", { flight_number: "?" }).isError).toBe(true);
    expect(call("send_email", { to: "not-an-email", subject: "s", body: "b" }).isError).toBe(true);
  });
});
