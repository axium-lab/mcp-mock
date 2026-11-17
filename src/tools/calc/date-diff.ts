import { structured, type Tool, toolError } from "../types.ts";
import { PURE } from "./annotations.ts";

// A calendar date (read as UTC midnight) or a date-time with an explicit
// offset. A date-time without one would be read in the machine's local time
// zone, so the same request would answer differently on different machines.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parse(value: string): number | undefined {
  if (!DATE.test(value) && !DATE_TIME.test(value)) return undefined;
  const time = Date.parse(DATE.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(time)) return undefined;
  // Date.parse rolls 2024-02-30 over to March; a real calendar rejects it.
  const day = value.slice(0, 10);
  const roundTrip = new Date(Date.parse(`${day}T00:00:00Z`)).toISOString().slice(0, 10);
  return roundTrip === day ? time : undefined;
}

export const dateDiff: Tool = {
  definition: {
    name: "date_diff",
    title: "Date difference",
    description:
      "Computes the time from one ISO 8601 date to another. Dates are YYYY-MM-DD (UTC) or date-times with an offset, e.g. 2024-05-01T10:00:00Z.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "The start date." },
        to: { type: "string", description: "The end date." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        days: { type: "number" },
        hours: { type: "number" },
        seconds: { type: "number" },
      },
      required: ["days", "hours", "seconds"],
    },
    annotations: PURE,
  },
  run: ({ from, to }) => {
    const start = parse(from as string);
    if (start === undefined) return toolError(`Invalid date "${from as string}": expected YYYY-MM-DD or an ISO 8601 date-time with an offset`);
    const end = parse(to as string);
    if (end === undefined) return toolError(`Invalid date "${to as string}": expected YYYY-MM-DD or an ISO 8601 date-time with an offset`);
    const seconds = (end - start) / 1000;
    return structured({ days: seconds / 86400, hours: seconds / 3600, seconds });
  },
};
