import { structured, type Tool, toolError } from "../types.ts";
import { PURE } from "./annotations.ts";

// A recursive-descent parser for arithmetic, never eval:
//   expression := term (("+" | "-") term)*
//   term       := unary (("*" | "/" | "%") unary)*
//   unary      := "-" unary | power
//   power      := primary ("^" unary)?        right-associative
//   primary    := number | "(" expression ")"
// Exponentiation binds tighter than negation, so -2^2 is -4, as in maths and
// Python, and 2^-1 is 0.5.
class ExpressionError extends Error {}

function evaluate(source: string): number {
  let pos = 0;

  const skipSpaces = () => {
    while (source[pos] === " " || source[pos] === "\t") pos++;
  };
  const peek = () => {
    skipSpaces();
    return source[pos];
  };
  const fail = (): never => {
    const found = pos < source.length ? `'${source[pos]}'` : "end of input";
    throw new ExpressionError(`unexpected ${found} at position ${pos + 1}`);
  };

  const primary = (): number => {
    if (peek() === "(") {
      pos++;
      const value = expression();
      if (peek() !== ")") fail();
      pos++;
      return value;
    }
    const match = /^\d+(\.\d+)?|^\.\d+/.exec(source.slice(pos));
    if (!match) return fail();
    pos += match[0].length;
    return Number(match[0]);
  };
  const power = (): number => {
    const base = primary();
    if (peek() === "^") {
      pos++;
      return base ** unary();
    }
    return base;
  };
  const unary = (): number => {
    if (peek() === "-") {
      pos++;
      return -unary();
    }
    return power();
  };
  const term = (): number => {
    let value = unary();
    for (let op = peek(); op === "*" || op === "/" || op === "%"; op = peek()) {
      pos++;
      const right = unary();
      if ((op === "/" || op === "%") && right === 0) throw new ExpressionError("division by zero");
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  const expression = (): number => {
    let value = term();
    for (let op = peek(); op === "+" || op === "-"; op = peek()) {
      pos++;
      const right = term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };

  const value = expression();
  if (peek() !== undefined) fail();
  return value;
}

export const calculate: Tool = {
  definition: {
    name: "calculate",
    title: "Calculate",
    description:
      "Evaluates an arithmetic expression with + - * / % ^ and parentheses, e.g. '(2 + 3) * 4'.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "The expression to evaluate.",
          minLength: 1,
          maxLength: 1000,
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { result: { type: "number" } },
      required: ["result"],
    },
    annotations: PURE,
  },
  run: ({ expression }) => {
    try {
      const result = evaluate(expression as string);
      if (!Number.isFinite(result)) return toolError("Cannot evaluate expression: the result is not a finite number");
      return structured({ result });
    } catch (error) {
      if (error instanceof ExpressionError) return toolError(`Cannot evaluate expression: ${error.message}`);
      throw error;
    }
  },
};
