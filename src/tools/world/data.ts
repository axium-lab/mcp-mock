import type { ToolAnnotations } from "../types.ts";

// Fake-world tools stand in for external services: they read from an open
// world, but never change it, and the same call returns the same answer.
export const LOOKUP: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// The value each tool reserves to fail on purpose, compared after the same
// normalization the tool applies to its argument. Documented, few and
// explicit: a test can provoke every failure path without hidden magic.
export const RESERVED = {
  place: "atlantis",
  searchQuery: "error",
  stockSymbol: "XXXX",
  currency: "XXX",
  userId: "missing",
  flightNumber: "XX000",
  filePath: "/missing",
  bouncingEmail: "bounce@example.com",
} as const;

export const CONDITIONS = ["sunny", "partly cloudy", "cloudy", "rain", "thunderstorm", "fog", "windy"] as const;
export const COLD_CONDITIONS = ["snow", "cloudy", "fog", "sunny"] as const;

export const FIRST_NAMES = [
  "Ada",
  "Alan",
  "Grace",
  "Linus",
  "Margaret",
  "Dennis",
  "Barbara",
  "Ken",
  "Frances",
  "Edsger",
  "Radia",
  "Tim",
] as const;

export const LAST_NAMES = [
  "Lovelace",
  "Turing",
  "Hopper",
  "Torvalds",
  "Hamilton",
  "Ritchie",
  "Liskov",
  "Thompson",
  "Allen",
  "Dijkstra",
  "Perlman",
  "Berners-Lee",
] as const;

export const ROLES = ["admin", "editor", "viewer"] as const;

export const AIRPORTS = ["MAD", "BCN", "LHR", "CDG", "FRA", "AMS", "JFK", "SFO", "NRT", "SYD", "GRU", "DXB"] as const;

export const FLIGHT_STATUSES = ["scheduled", "on_time", "delayed", "cancelled", "landed"] as const;

export const WORDS = [
  "guide",
  "overview",
  "tutorial",
  "reference",
  "news",
  "analysis",
  "documentation",
  "examples",
  "comparison",
  "history",
  "faq",
  "review",
] as const;
