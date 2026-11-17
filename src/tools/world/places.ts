import { normalizeText, seeded, titleCase } from "../hash.ts";
import { structured, type Tool, toolError } from "../types.ts";
import { AIRPORTS, FLIGHT_STATUSES, LOOKUP, RESERVED } from "./data.ts";

export const geocode: Tool = {
  definition: {
    name: "geocode",
    title: "Geocode",
    description: `Finds the coordinates of an address. Fake but stable. "${titleCase(RESERVED.place)}" is never found.`,
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", minLength: 1, description: "The address to locate." } },
      required: ["address"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        formatted_address: { type: "string" },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
      },
      required: ["formatted_address", "latitude", "longitude"],
    },
    annotations: LOOKUP,
  },
  run: ({ address }) => {
    const key = normalizeText(address as string);
    if (key === RESERVED.place) return toolError(`Address not found: ${titleCase(key)}`);

    const random = seeded("geocode", key);
    return structured({
      formatted_address: titleCase(key),
      latitude: random.float(-60, 70, 6),
      longitude: random.float(-180, 180, 6),
    });
  },
};

const time = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// Many fields, some present only for some statuses: the shape a client has to
// handle without assuming every field is always there. Times are local
// "HH:MM" without a date, which would need the server's clock.
export const getFlightStatus: Tool = {
  definition: {
    name: "get_flight_status",
    title: "Flight status",
    description: `Gets the status of a flight by number, e.g. IB3456. Fake but stable. "${RESERVED.flightNumber}" is never found.`,
    inputSchema: {
      type: "object",
      properties: {
        flight_number: {
          type: "string",
          pattern: "^\\s*[A-Za-z0-9]{2}\\d{1,4}\\s*$",
          description: "Airline code followed by 1 to 4 digits.",
        },
      },
      required: ["flight_number"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        flight_number: { type: "string" },
        status: { type: "string", enum: [...FLIGHT_STATUSES] },
        departure_airport: { type: "string" },
        arrival_airport: { type: "string" },
        scheduled_departure: { type: "string" },
        estimated_departure: { type: "string" },
        delay_minutes: { type: "integer" },
        terminal: { type: "string" },
        gate: { type: "string" },
      },
      required: ["flight_number", "status", "departure_airport", "arrival_airport", "scheduled_departure"],
    },
    annotations: LOOKUP,
  },
  run: ({ flight_number }) => {
    const key = (flight_number as string).trim().toUpperCase();
    if (key === RESERVED.flightNumber) return toolError(`Flight not found: ${key}`);

    const random = seeded("get_flight_status", key);
    const status = random.pick(FLIGHT_STATUSES);
    const departure = random.pick(AIRPORTS);
    const arrival = random.pick(AIRPORTS.filter((code) => code !== departure));
    const scheduled = random.int(5 * 60, 23 * 60);
    const delay = random.int(15, 180);
    const terminal = String(random.int(1, 5));
    const gate = `${random.pick(["A", "B", "C", "D"])}${random.int(1, 40)}`;

    return structured({
      flight_number: key,
      status,
      departure_airport: departure,
      arrival_airport: arrival,
      scheduled_departure: time(scheduled),
      ...(status === "delayed" && { estimated_departure: time(scheduled + delay), delay_minutes: delay }),
      ...(status !== "cancelled" && { terminal, gate }),
    });
  },
};
