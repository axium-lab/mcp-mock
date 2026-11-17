# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project foundation: Express server on Bun that also runs on Node, with a `/health` endpoint reporting the running version.
- Transport-agnostic JSON-RPC 2.0 core: message parsing and classification, and dispatch to method handlers with standard error responses.
- The five supported spec revisions (2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05) and their era, modern or legacy.
- Official `schema.json` of every revision, vendored under `schemas/`, and a test harness that validates messages against them.
- Tests through the official MCP TypeScript SDK client.
- `/2026-07-28/mcp`: the modern, stateless revision over Streamable HTTP. Each request carries its protocol version and client capabilities in `_meta`, with no handshake and no session. It serves `server/discover`, `tools/list` (with `ttlMs`, `cacheScope` and a deterministic order) and `tools/call` with an `echo` tool, and every result carries `resultType` and the server identity in `_meta`.
- Request validation in the same order as the official SDK server: JSON-RPC shape, era, `_meta` envelope, header/body agreement, supported version, the standard `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers (Base64 sentinel included), and method existence. Each failure answers with the HTTP status and error code the spec assigns (`-32020`, `-32022`, `-32602`, `-32601`), and errors from handlers travel in-band with HTTP 200.
- Legacy clients reaching `/2026-07-28/mcp` (an `initialize`, or any request without `_meta`) get an `UnsupportedProtocolVersionError` that lists the versions served. GET and DELETE answer `405`, and a session id is ignored and never minted.

- `/2025-11-25/mcp`: the first legacy revision, served without sessions. It answers `initialize` (always with its own version, as the spec's negotiation prescribes for a version it does not support), `ping`, `tools/list` and `tools/call` with the same `echo` tool, without the 2026-07-28 additions. Notifications and posted responses get `202`, a `MCP-Protocol-Version` header naming another version gets `400`, and GET and DELETE answer `405`, since the mock offers no server stream and no session to end. Clients that connect as legacy by default, like the MCP Inspector, work against it unchanged.

- `/mcp`: a dual-era endpoint that serves any client without configuration. Each request's era is read from how it opens, never remembered: a request with the `_meta` envelope, or with a modern `MCP-Protocol-Version` header, is served as 2026-07-28, and everything else, `initialize` included, as 2025-11-25. Each era advertises only its own versions, so a modern client is never offered a legacy one to put in `_meta`.

- A catalog of 20 tools, served by every endpoint in a fixed order:
  - Ten real computations: `echo`, `add`, `calculate` (a safe parser, no `eval`), `transform_text`, `text_stats`, `sort_list`, `convert_units`, `hash_text`, `date_diff` and `color_swatch`, which returns a real PNG.
  - Ten fake-world tools: `get_weather`, `get_forecast`, `search_web`, `get_stock_price`, `convert_currency`, `get_user`, `geocode`, `get_flight_status`, `read_file` and `send_email`. Their data is derived from a hash of the normalized arguments: the same arguments always return the same bytes, on Bun and on Node, and different arguments return different, internally consistent data.
  - Each fake-world tool fails on one documented reserved value (`city: "Atlantis"`, `user_id: "missing"`, `to: "bounce@example.com"`…), so tests can reach every failure path.
  - Results cover every content type: text, structured content with an output schema, `image`, `resource_link` and embedded `resource`. Annotations tell read-only lookups from `send_email`.
  - Arguments that break a tool's input schema are a tool execution error (`isError: true`), never a protocol error.

### Fixed

- JSON-RPC errors whose request id cannot be read omit `id` instead of sending `id: null`, which no MCP schema allows.

[Unreleased]: https://github.com/axium-lab/mcp-mock/commits/main
