import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { callTool } from "../../src/tools/index.ts";
import type { ToolResult } from "../../src/tools/types.ts";

// The real computations: results checked against independent answers.
const call = (name: string, args: Record<string, unknown>): ToolResult => callTool({ name, arguments: args }) as ToolResult;
const data = (name: string, args: Record<string, unknown>) => call(name, args).structuredContent;
const errorText = (result: ToolResult) => {
  expect(result.isError).toBe(true);
  return (result.content[0] as { text: string }).text;
};

describe("echo", () => {
  it("returns the text intact, unicode included", () => {
    expect(call("echo", { text: "¡Hola, 世界! 👋" }).content).toEqual([
      { type: "text", text: "Echo: ¡Hola, 世界! 👋" },
    ]);
  });
});

describe("add", () => {
  it("adds, with plain floating-point semantics", () => {
    expect(data("add", { a: 2, b: 3 })).toEqual({ sum: 5 });
    expect(data("add", { a: 0.1, b: 0.2 })).toEqual({ sum: 0.30000000000000004 });
  });

  it("gives the same data as text and as structured content", () => {
    const result = call("add", { a: 1, b: 2 });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it("rejects non-numbers as a tool execution error", () => {
    expect(errorText(call("add", { a: "1", b: 2 }))).toContain('"a" must be a number');
  });
});

describe("calculate", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["10 / 4", 2.5],
    ["10 % 4", 2],
    ["2^3^2", 512],
    ["-2^2", -4],
    ["2^-1", 0.5],
    ["--3", 3],
    [".5 + 1.25", 1.75],
  ])("evaluates %s as %d", (expression, result) => {
    expect(data("calculate", { expression })).toEqual({ result });
  });

  it("reports division by zero", () => {
    expect(errorText(call("calculate", { expression: "1 / (2 - 2)" }))).toContain("division by zero");
  });

  it("points at the first syntax error", () => {
    expect(errorText(call("calculate", { expression: "2 + * 3" }))).toContain("unexpected '*' at position 5");
    expect(errorText(call("calculate", { expression: "(1 + 2" }))).toContain("end of input");
  });

  it("refuses results that are not finite", () => {
    expect(errorText(call("calculate", { expression: "10^400" }))).toContain("not a finite number");
  });
});

describe("transform_text", () => {
  it.each([
    ["upper", "Straße", "STRASSE"],
    ["lower", "ÀBC", "àbc"],
    ["reverse", "ab👋c", "c👋ba"],
    ["slug", "  ¡Hola, Mundo! Ça va?  ", "hola-mundo-ca-va"],
  ])("applies %s", (operation, text, result) => {
    expect(data("transform_text", { text, operation })).toEqual({ result });
  });

  it("rejects an unknown operation", () => {
    expect(errorText(call("transform_text", { text: "x", operation: "shout" }))).toContain("must be one of");
  });
});

describe("text_stats", () => {
  it("counts words, code points and lines", () => {
    expect(data("text_stats", { text: "one  two\r\nthree 👋" })).toEqual({ words: 4, chars: 17, lines: 2 });
    expect(data("text_stats", { text: "" })).toEqual({ words: 0, chars: 0, lines: 0 });
  });
});

describe("sort_list", () => {
  it("sorts by code point, not by locale", () => {
    expect(data("sort_list", { items: ["pear", "Apple", "fig", "apple"] })).toEqual({
      items: ["Apple", "apple", "fig", "pear"],
    });
    expect(data("sort_list", { items: ["b", "a", "c"], order: "desc" })).toEqual({ items: ["c", "b", "a"] });
  });

  it("rejects non-string items", () => {
    expect(errorText(call("sort_list", { items: ["a", 1] }))).toContain('"items[1]" must be a string');
  });
});

describe("convert_units", () => {
  it.each([
    [1, "in", "cm", 2.54],
    [1, "mi", "km", 1.609344],
    [100, "c", "f", 212],
    [32, "f", "c", 0],
    [0, "k", "c", -273.15],
    [2, "lb", "g", 907.18474],
    [90, "min", "h", 1.5],
  ])("converts %d %s to %s", (value, from, to, result) => {
    expect(data("convert_units", { value, from, to })).toEqual({ value: result, unit: to });
  });

  it("refuses units of different dimensions", () => {
    expect(errorText(call("convert_units", { value: 1, from: "kg", to: "km" }))).toContain(
      "mass and length are different dimensions",
    );
  });
});

describe("hash_text", () => {
  it.each(["md5", "sha1", "sha256"])("matches node:crypto for %s", (algorithm) => {
    const expected = createHash(algorithm).update("¡hola!", "utf8").digest("hex");
    expect(data("hash_text", { text: "¡hola!", algorithm })).toEqual({ algorithm, hex: expected });
  });

  it("matches the published SHA-256 test vector", () => {
    expect(data("hash_text", { text: "abc", algorithm: "sha256" })).toMatchObject({
      hex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });
});

describe("date_diff", () => {
  it("measures calendar dates and offsets", () => {
    expect(data("date_diff", { from: "2024-01-01", to: "2024-03-01" })).toEqual({
      days: 60,
      hours: 1440,
      seconds: 5_184_000,
    });
    expect(data("date_diff", { from: "2024-01-01T10:00:00+02:00", to: "2024-01-01T09:00:00Z" })).toEqual({
      days: 1 / 24,
      hours: 1,
      seconds: 3600,
    });
  });

  it.each([
    ["2024-02-30", "a day that does not exist"],
    ["2024-01-01T10:00:00", "a date-time without an offset"],
    ["01/02/2024", "a non-ISO format"],
  ])("refuses %s (%s)", (from) => {
    expect(errorText(call("date_diff", { from, to: "2024-01-01" }))).toContain("Invalid date");
  });
});

describe("color_swatch", () => {
  function decode(result: ToolResult) {
    const block = result.content[0] as { type: string; data: string; mimeType: string };
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/png");
    const png = Buffer.from(block.data, "base64");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const size = png.readUInt32BE(16);
    const idatLength = png.readUInt32BE(33);
    const pixels = inflateSync(png.subarray(41, 41 + idatLength));
    return { size, pixels };
  }

  it("renders a PNG that a real zlib decodes to the right pixels", () => {
    const { size, pixels } = decode(call("color_swatch", { color: "#f80", size: 3 }));
    expect(size).toBe(3);
    expect(pixels.length).toBe(3 * (1 + 3 * 3));
    expect([...pixels.subarray(0, 4)]).toEqual([0, 0xff, 0x88, 0x00]);
  });

  it("accepts names and defaults to 16 pixels", () => {
    expect(decode(call("color_swatch", { color: " Purple " })).size).toBe(16);
  });

  it("stays decodable at the largest size, which spans several stored blocks", () => {
    const { pixels } = decode(call("color_swatch", { color: "white", size: 64 }));
    expect(pixels.length).toBe(64 * (1 + 64 * 3));
  });

  it("is byte-identical for the same arguments", () => {
    expect(call("color_swatch", { color: "red" })).toEqual(call("color_swatch", { color: "red" }));
  });

  it("refuses unknown colours and oversized swatches", () => {
    expect(errorText(call("color_swatch", { color: "#12" }))).toContain("Unknown colour");
    expect(errorText(call("color_swatch", { color: "red", size: 65 }))).toContain('"size" must be <= 64');
  });
});
