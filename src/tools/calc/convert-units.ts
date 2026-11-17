import { structured, type Tool, toolError } from "../types.ts";
import { PURE } from "./annotations.ts";

interface Unit {
  dimension: string;
  // Conversion to and from the dimension's base unit.
  toBase: (value: number) => number;
  fromBase: (value: number) => number;
}

const linear = (dimension: string, factor: number): Unit => ({
  dimension,
  toBase: (value) => value * factor,
  fromBase: (value) => value / factor,
});

// Base units: metre, gram, second, kelvin.
const UNITS: Record<string, Unit> = {
  mm: linear("length", 0.001),
  cm: linear("length", 0.01),
  m: linear("length", 1),
  km: linear("length", 1000),
  in: linear("length", 0.0254),
  ft: linear("length", 0.3048),
  yd: linear("length", 0.9144),
  mi: linear("length", 1609.344),
  mg: linear("mass", 0.001),
  g: linear("mass", 1),
  kg: linear("mass", 1000),
  oz: linear("mass", 28.349523125),
  lb: linear("mass", 453.59237),
  s: linear("time", 1),
  min: linear("time", 60),
  h: linear("time", 3600),
  d: linear("time", 86400),
  c: { dimension: "temperature", toBase: (v) => v + 273.15, fromBase: (v) => v - 273.15 },
  f: {
    dimension: "temperature",
    toBase: (v) => ((v - 32) * 5) / 9 + 273.15,
    fromBase: (v) => ((v - 273.15) * 9) / 5 + 32,
  },
  k: linear("temperature", 1),
};

const unitSchema = (description: string) => ({
  type: "string",
  enum: Object.keys(UNITS),
  description,
});

export const convertUnits: Tool = {
  definition: {
    name: "convert_units",
    title: "Convert units",
    description:
      "Converts a value between units of length, mass, time or temperature (c, f and k are Celsius, Fahrenheit and Kelvin).",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "The value to convert." },
        from: unitSchema("The unit of the value."),
        to: unitSchema("The unit to convert to."),
      },
      required: ["value", "from", "to"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { value: { type: "number" }, unit: { type: "string" } },
      required: ["value", "unit"],
    },
    annotations: PURE,
  },
  run: ({ value, from, to }) => {
    const source = UNITS[from as string] as Unit;
    const target = UNITS[to as string] as Unit;
    if (source.dimension !== target.dimension) {
      return toolError(
        `Cannot convert ${from as string} to ${to as string}: ${source.dimension} and ${target.dimension} are different dimensions`,
      );
    }
    // Twelve significant digits hide floating-point noise (1 in → cm would
    // otherwise print 2.5400000000000005).
    const converted = Number(target.fromBase(source.toBase(value as number)).toPrecision(12));
    return structured({ value: converted, unit: to as string });
  },
};
