import { normalizeText, type Random, round, seeded, titleCase } from "../hash.ts";
import { structured, type Tool, toolError } from "../types.ts";
import { COLD_CONDITIONS, CONDITIONS, LOOKUP, RESERVED } from "./data.ts";

const UNITS = {
  type: "string",
  enum: ["metric", "imperial"],
  description: "metric (°C, km/h) or imperial (°F, mph). Defaults to metric.",
};

export const toFahrenheit = (celsius: number) => round((celsius * 9) / 5 + 32, 1);
const toMph = (kmh: number) => round(kmh / 1.609344, 1);

// A plausible reading: snow only when it is cold enough.
export function reading(random: Random): { celsius: number; conditions: string } {
  const celsius = random.int(-10, 38);
  const conditions = random.pick(celsius <= 2 ? COLD_CONDITIONS : CONDITIONS);
  return { celsius, conditions };
}

// The weather depends only on the city: `units` converts the same reading,
// so metric and imperial always agree.
export const getWeather: Tool = {
  definition: {
    name: "get_weather",
    title: "Current weather",
    description: `Gets the current weather for a city. Fake but stable: the same city always reports the same weather. "${titleCase(RESERVED.place)}" is never found.`,
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", minLength: 1, description: "The city name." },
        units: UNITS,
      },
      required: ["city"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        temperature: { type: "number" },
        temperature_unit: { type: "string", enum: ["°C", "°F"] },
        conditions: { type: "string" },
        humidity: { type: "integer", minimum: 0, maximum: 100 },
        wind_speed: { type: "number" },
        wind_speed_unit: { type: "string", enum: ["km/h", "mph"] },
      },
      required: ["city", "temperature", "temperature_unit", "conditions", "humidity", "wind_speed", "wind_speed_unit"],
    },
    annotations: LOOKUP,
  },
  run: ({ city, units }) => {
    const key = normalizeText(city as string);
    if (key === RESERVED.place) return toolError(`City not found: ${titleCase(key)}`);

    const random = seeded("get_weather", key);
    const { celsius, conditions } = reading(random);
    const humidity = random.int(20, 95);
    const kmh = random.int(0, 60);
    const imperial = units === "imperial";
    return structured({
      city: titleCase(key),
      temperature: imperial ? toFahrenheit(celsius) : celsius,
      temperature_unit: imperial ? "°F" : "°C",
      conditions,
      humidity,
      wind_speed: imperial ? toMph(kmh) : kmh,
      wind_speed_unit: imperial ? "mph" : "km/h",
    });
  },
};

// Days are numbered from 1 (tomorrow) rather than dated: a date would need
// the server's clock, and the answer would change from one day to the next.
export const getForecast: Tool = {
  definition: {
    name: "get_forecast",
    title: "Weather forecast",
    description: `Gets a daily forecast for the next 1 to 7 days. Days are numbered from 1 (tomorrow). "${titleCase(RESERVED.place)}" is never found.`,
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", minLength: 1, description: "The city name." },
        days: { type: "integer", minimum: 1, maximum: 7, description: "How many days to forecast." },
        units: UNITS,
      },
      required: ["city", "days"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        temperature_unit: { type: "string", enum: ["°C", "°F"] },
        days: {
          type: "array",
          items: {
            type: "object",
            properties: {
              day: { type: "integer" },
              high: { type: "number" },
              low: { type: "number" },
              conditions: { type: "string" },
              precipitation_chance: { type: "integer", minimum: 0, maximum: 100 },
            },
            required: ["day", "high", "low", "conditions", "precipitation_chance"],
          },
        },
      },
      required: ["city", "temperature_unit", "days"],
    },
    annotations: LOOKUP,
  },
  run: ({ city, days, units }) => {
    const key = normalizeText(city as string);
    if (key === RESERVED.place) return toolError(`City not found: ${titleCase(key)}`);

    // Seeded on the city alone, so asking for 3 days returns the first 3 of
    // the 7-day forecast.
    const random = seeded("get_forecast", key);
    const imperial = units === "imperial";
    const forecast = Array.from({ length: 7 }, (_, index) => {
      const { celsius, conditions } = reading(random);
      const low = celsius - random.int(3, 10);
      return {
        day: index + 1,
        high: imperial ? toFahrenheit(celsius) : celsius,
        low: imperial ? toFahrenheit(low) : low,
        conditions,
        precipitation_chance: random.int(0, 100),
      };
    });
    return structured({
      city: titleCase(key),
      temperature_unit: imperial ? "°F" : "°C",
      days: forecast.slice(0, days as number),
    });
  },
};
