// The spec revisions mcp-mock speaks, newest first. The spec splits them in
// two eras: "modern" revisions carry version and capabilities in every
// request's _meta and keep no state; "legacy" ones open a session with the
// initialize handshake.
export type Era = "modern" | "legacy";

export interface Revision {
  id: string;
  era: Era;
}

export const REVISIONS = [
  { id: "2026-07-28", era: "modern" },
  { id: "2025-11-25", era: "legacy" },
  { id: "2025-06-18", era: "legacy" },
  { id: "2025-03-26", era: "legacy" },
  { id: "2024-11-05", era: "legacy" },
] as const satisfies readonly Revision[];

export type RevisionId = (typeof REVISIONS)[number]["id"];

export const LATEST_REVISION: RevisionId = REVISIONS[0].id;

export function isRevisionId(value: string): value is RevisionId {
  return REVISIONS.some((revision) => revision.id === value);
}

export function eraOf(id: RevisionId): Era {
  // isRevisionId-narrowed ids always resolve, so the lookup cannot miss.
  return (REVISIONS.find((revision) => revision.id === id) as Revision).era;
}
