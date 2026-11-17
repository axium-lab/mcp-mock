import { describe, expect, it } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { callTool, listTools } from "../../src/tools/index.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import { validateArgs } from "../../src/tools/validate.ts";
import { SAMPLES, TOOL_NAMES } from "../catalog.ts";

// The schemas the catalog publishes are real JSON Schema 2020-12 (the dialect
// the spec defaults to), the results honour them, and the mock's own small
// validator agrees with a full one.
const ajv = new Ajv2020({ strict: false });

describe.each(listTools().map((tool) => [tool.name, tool] as const))("%s", (name, tool) => {
  it("publishes schemas a full JSON Schema validator compiles", () => {
    expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
    const output = tool.outputSchema;
    if (output) expect(() => ajv.compile(output)).not.toThrow();
  });

  it("returns structured content that matches its output schema", () => {
    // Without an MRTR context every tool completes, delete_file included.
    const result = callTool({ name, arguments: SAMPLES[name] }) as ToolResult;
    expect(result.isError).toBeUndefined();
    if (tool.outputSchema) {
      const validate = ajv.compile(tool.outputSchema);
      expect(validate(result.structuredContent)).toBe(true);
    } else {
      expect(result.structuredContent).toBeUndefined();
    }
  });

  it("accepts its sample, and the full validator agrees", () => {
    const args = SAMPLES[name] as Record<string, unknown>;
    expect(validateArgs(args, tool.inputSchema)).toBeUndefined();
    expect(ajv.compile(tool.inputSchema)(args)).toBe(true);
  });

  it("rejects an unexpected argument, as the full validator does", () => {
    const args = { ...SAMPLES[name], unexpected: true };
    expect(validateArgs(args, tool.inputSchema)).toContain("unexpected argument(s): unexpected");
    expect(ajv.compile(tool.inputSchema)(args)).toBe(false);
  });
});

it("has a sample for every tool", () => {
  expect(Object.keys(SAMPLES)).toEqual(TOOL_NAMES);
});
