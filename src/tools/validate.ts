import type { Args, JsonSchema } from "./types.ts";

// Checks tool arguments against the small JSON Schema subset the catalog's
// input schemas use: an object with typed properties (string, number,
// integer, boolean, array of strings), enum, minimum/maximum, minLength,
// maxLength, pattern, required and additionalProperties: false. A full
// validator would be a runtime dependency for schemas we write ourselves.
//
// Returns the first problem found, or undefined when the arguments are valid.

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function checkValue(name: string, value: unknown, schema: JsonSchema): string | undefined {
  const type = schema.type;
  if (type === "string") {
    if (typeof value !== "string") return `"${name}" must be a string, got ${describe(value)}`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return `"${name}" must be at least ${schema.minLength} character(s) long`;
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return `"${name}" must be at most ${schema.maxLength} characters long`;
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      return `"${name}" must match ${schema.pattern}`;
    }
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `"${name}" must be a number, got ${describe(value)}`;
    }
    if (type === "integer" && !Number.isInteger(value)) return `"${name}" must be an integer`;
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `"${name}" must be >= ${schema.minimum}`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `"${name}" must be <= ${schema.maximum}`;
    }
  } else if (type === "boolean") {
    if (typeof value !== "boolean") return `"${name}" must be a boolean, got ${describe(value)}`;
  } else if (type === "array") {
    if (!Array.isArray(value)) return `"${name}" must be an array, got ${describe(value)}`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `"${name}" must have at most ${schema.maxItems} items`;
    }
    const items = schema.items as JsonSchema | undefined;
    if (items) {
      for (const [index, item] of value.entries()) {
        const problem = checkValue(`${name}[${index}]`, item, items);
        if (problem) return problem;
      }
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `"${name}" must be one of: ${schema.enum.join(", ")}`;
  }
  return undefined;
}

export function validateArgs(args: Args, schema: JsonSchema): string | undefined {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const key of (schema.required ?? []) as string[]) {
    if (!(key in args)) return `"${key}" is required`;
  }
  if (schema.additionalProperties === false) {
    const extra = Object.keys(args).filter((key) => !Object.hasOwn(properties, key));
    if (extra.length > 0) return `unexpected argument(s): ${extra.join(", ")}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (property) {
      const problem = checkValue(key, value, property);
      if (problem) return problem;
    }
  }
  return undefined;
}
