// The per-request envelope: since 2026-07-28 every request carries its
// protocol version and client capabilities in params._meta, replacing the
// initialize handshake. Pure validation, no transport involved, so stdio can
// reuse it.

export const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  logLevel: "io.modelcontextprotocol/logLevel",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

const LOG_LEVELS = new Set([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
]);

export interface EnvelopeIssue {
  key: string;
  problem: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function metaOf(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const meta = params?._meta;
  return isObject(meta) ? meta : undefined;
}

// A request claims the modern era by carrying the protocol-version key, valid
// or not: a malformed claim is an error to report, never a reason to treat the
// request as legacy.
export function hasClaim(params: Record<string, unknown> | undefined): boolean {
  const meta = metaOf(params);
  return meta !== undefined && META.protocolVersion in meta;
}

export function claimedVersion(params: Record<string, unknown> | undefined): string | undefined {
  const version = metaOf(params)?.[META.protocolVersion];
  return typeof version === "string" ? version : undefined;
}

// Missing required keys first, then malformed present ones, in a stable order
// so the same request always reports the same issue.
export function validateEnvelope(meta: Record<string, unknown>): EnvelopeIssue[] {
  const issues: EnvelopeIssue[] = [];
  for (const key of [META.protocolVersion, META.clientCapabilities]) {
    if (!(key in meta)) issues.push({ key, problem: "missing" });
  }

  const version = meta[META.protocolVersion];
  if (META.protocolVersion in meta && typeof version !== "string") {
    issues.push({ key: META.protocolVersion, problem: "expected a protocol version string" });
  }
  if (META.clientCapabilities in meta && !isObject(meta[META.clientCapabilities])) {
    issues.push({ key: META.clientCapabilities, problem: "expected an object" });
  }
  if (META.clientInfo in meta) {
    const info = meta[META.clientInfo];
    if (!isObject(info) || typeof info.name !== "string" || typeof info.version !== "string") {
      issues.push({ key: META.clientInfo, problem: "expected an object with string name and version" });
    }
  }
  if (META.logLevel in meta) {
    const level = meta[META.logLevel];
    if (typeof level !== "string" || !LOG_LEVELS.has(level)) {
      issues.push({ key: META.logLevel, problem: "expected a logging level" });
    }
  }
  return issues;
}
