import { solidPng } from "../png.ts";
import { type Tool, toolError } from "../types.ts";
import { PURE } from "./annotations.ts";

const NAMED: Record<string, readonly [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  pink: [255, 192, 203],
  gray: [128, 128, 128],
};

function parseColor(value: string): readonly [number, number, number] | undefined {
  const color = value.trim().toLowerCase();
  if (Object.hasOwn(NAMED, color)) return NAMED[color];
  // #rgb is shorthand for #rrggbb.
  const hex = /^#[0-9a-f]{3}$/.test(color)
    ? Array.from(color.slice(1), (digit) => digit + digit).join("")
    : /^#[0-9a-f]{6}$/.test(color)
      ? color.slice(1)
      : undefined;
  if (hex === undefined) return undefined;
  const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  return [channel(0), channel(2), channel(4)];
}

// Exercises the image content type: a real PNG, base64-encoded, identical for
// the same arguments.
export const colorSwatch: Tool = {
  definition: {
    name: "color_swatch",
    title: "Colour swatch",
    description: `Renders a square PNG of a solid colour. Accepts #rgb, #rrggbb or a name: ${Object.keys(NAMED).join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        color: { type: "string", description: "The colour to render." },
        size: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description: "Side length in pixels. Defaults to 16.",
        },
      },
      required: ["color"],
      additionalProperties: false,
    },
    annotations: PURE,
  },
  run: ({ color, size }) => {
    const rgb = parseColor(color as string);
    if (!rgb) return toolError(`Unknown colour "${color as string}": use #rgb, #rrggbb or a colour name`);
    const png = solidPng((size as number | undefined) ?? 16, rgb);
    return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
  },
};
