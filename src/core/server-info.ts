import pkg from "../../package.json" with { type: "json" };

// How the mock names itself: in /health, and in the serverInfo every MCP
// revision reports (the initialize result before 2026-07-28, each result's
// _meta from it on). The version comes from package.json, so a running
// container can be matched against the release it was built from.
export const SERVER_INFO = { name: "mcp-mock", version: pkg.version } as const;
