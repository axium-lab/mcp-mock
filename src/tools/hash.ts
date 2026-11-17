import { createHash } from "node:crypto";

// Deterministic fake data: a tool hashes what identifies its answer (the tool
// name plus normalized arguments) and draws every value from a generator
// seeded with that hash. Same arguments, same bytes, on any machine and
// runtime; different arguments, different data.
//
// The algorithm is part of the public contract: changing the hash, the
// generator or the order of draws changes every response and breaks users'
// snapshots, so it only changes in a major release.

// JSON with sorted keys, so { a, b } and { b, a } seed the same generator.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface Random {
  // A float in [0, 1).
  next(): number;
  // An integer in [min, max], both included.
  int(min: number, max: number): number;
  // A float in [min, max) rounded to `decimals` places.
  float(min: number, max: number, decimals: number): number;
  pick<T>(items: readonly T[]): T;
  // `bytes` random bytes as lowercase hex.
  hex(bytes: number): string;
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// sfc32: a small, well-distributed 32-bit generator, seeded with the first
// 16 bytes of SHA-256(canonical key).
export function seeded(tool: string, key: unknown): Random {
  const digest = createHash("sha256").update(`${tool}\n${canonical(key)}`).digest();
  let a = digest.readUInt32BE(0);
  let b = digest.readUInt32BE(4);
  let c = digest.readUInt32BE(8);
  let d = digest.readUInt32BE(12);

  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max, decimals) => round(min + next() * (max - min), decimals),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    hex: (bytes) =>
      Array.from({ length: bytes }, () =>
        Math.floor(next() * 256)
          .toString(16)
          .padStart(2, "0"),
      ).join(""),
  };
}

// The normalization most text arguments get before hashing and before
// matching reserved values: surrounding and repeated whitespace dropped,
// lowercased. " Madrid " and "madrid" are the same city.
export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// How a normalized name is displayed back: "new york" becomes "New York".
export function titleCase(value: string): string {
  return value.replace(/(^|[\s-])(\p{L})/gu, (_match, sep: string, letter: string) => sep + letter.toUpperCase());
}
