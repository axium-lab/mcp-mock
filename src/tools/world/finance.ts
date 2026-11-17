import { round, seeded } from "../hash.ts";
import { structured, type Tool, toolError } from "../types.ts";
import { LOOKUP, RESERVED } from "./data.ts";

export const getStockPrice: Tool = {
  definition: {
    name: "get_stock_price",
    title: "Stock price",
    description: `Gets the latest price of a stock by ticker symbol (1 to 5 letters). Fake but stable. "${RESERVED.stockSymbol}" is an unknown symbol.`,
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", pattern: "^\\s*[A-Za-z]{1,5}\\s*$", description: "The ticker symbol." },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        price: { type: "number" },
        currency: { type: "string" },
        change: { type: "number" },
        change_percent: { type: "number" },
      },
      required: ["symbol", "price", "currency", "change", "change_percent"],
    },
    annotations: LOOKUP,
  },
  run: ({ symbol }) => {
    const key = (symbol as string).trim().toUpperCase();
    if (key === RESERVED.stockSymbol) return toolError(`Unknown symbol: ${key}`);

    const random = seeded("get_stock_price", key);
    const price = random.float(5, 900, 2);
    const changePercent = random.float(-5, 5, 2);
    return structured({
      symbol: key,
      price,
      currency: "USD",
      change: round((price * changePercent) / 100, 2),
      change_percent: changePercent,
    });
  },
};

// Units of a currency per US dollar. Each currency gets one rate from its own
// hash, and every pair is derived from those, so converting A to B and back
// returns the original amount (up to rounding).
function perDollar(code: string): number {
  if (code === "USD") return 1;
  return seeded("convert_currency", code).float(0.2, 150, 4);
}

const CURRENCY = { type: "string", pattern: "^\\s*[A-Za-z]{3}\\s*$" };

export const convertCurrency: Tool = {
  definition: {
    name: "convert_currency",
    title: "Convert currency",
    description: `Converts an amount between currencies by ISO 4217 code. Rates are fake but consistent across pairs. "${RESERVED.currency}" (ISO's "no currency") is not supported.`,
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "The amount to convert." },
        from: { ...CURRENCY, description: "The currency of the amount." },
        to: { ...CURRENCY, description: "The currency to convert to." },
      },
      required: ["amount", "from", "to"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        from: { type: "string" },
        to: { type: "string" },
        rate: { type: "number" },
        result: { type: "number" },
      },
      required: ["amount", "from", "to", "rate", "result"],
    },
    annotations: LOOKUP,
  },
  run: ({ amount, from, to }) => {
    const source = (from as string).trim().toUpperCase();
    const target = (to as string).trim().toUpperCase();
    for (const code of [source, target]) {
      if (code === RESERVED.currency) return toolError(`Unsupported currency: ${code}`);
    }
    const rate = round(perDollar(target) / perDollar(source), 6);
    return structured({
      amount: amount as number,
      from: source,
      to: target,
      rate,
      result: round((amount as number) * rate, 2),
    });
  },
};
