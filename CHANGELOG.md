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

- `/2025-06-18/mcp`, built on the same legacy server as 2025-11-25 with two differences of its own: arguments that break a tool's input schema are a JSON-RPC `-32602` protocol error, as its spec lists them, and an error whose request id cannot be read carries `id: null`, as JSON-RPC 2.0 and the official SDK server send it (its schema has no valid form for that case). `/mcp` now serves it too: `initialize` negotiates between 2025-11-25 and 2025-06-18, and later requests are served as the version their header names.

- `/2025-03-26/mcp`, on the same legacy server. It accepts JSON-RPC batches, as the revision requires: requests are answered with an array of responses in order, a malformed element gets its own error without failing the rest, notifications and responses alone get `202`, and `initialize` is refused inside a batch. The catalog comes in the revision's vocabulary: no top-level `title` (it moves into `annotations.title`, which this revision has), no `outputSchema` or `structuredContent` (the JSON text block remains), and no `resource_link` blocks (`search_web`'s text keeps the URLs).
- `/mcp` now serves 2025-03-26 too, and treats a legacy request without `MCP-Protocol-Version` as 2025-03-26, as the spec prescribes: the header only arrived in 2025-06-18.

- 2024-11-05 over its deprecated HTTP+SSE transport, at `/2024-11-05/sse`: the first event names the message endpoint, POSTs are answered `202 Accepted`, and every response travels on the stream as a `message` event. Open streams are kept in memory by session id and forgotten when the connection closes, the one piece of state in the mock. Tools come without annotations or titles, which this revision did not have. Plain-text answers and error bodies follow the official SDK's SSE server.
- The same transport at the root, `/sse` and `/messages`, next to `/mcp`, as the spec suggests for servers that keep serving 2024-11-05 clients. Over it, `initialize` negotiates any legacy revision, and the session remembers the one negotiated.

- Control from the test, with nothing registered beforehand and nothing remembered between requests:
  - `_meta["com.mcp-mock/response"]` on a `tools/call` replaces its result with the given `text`, `content`, `structuredContent` and `isError`, for any tool name and without argument validation. Structured content without content is repeated as JSON text, and the result is adapted to each revision like the catalog's own.
  - `_meta["com.mcp-mock/error"]` makes any request fail with the given JSON-RPC `code`, `message` and `data`.
  - The `x-mcp-mock-status` header forces an HTTP failure from 400 to 599 on every endpoint and transport, with `Retry-After` on `429`, as `x-llm-mock-status` does in llm-mock. An out-of-range value is refused with `400` rather than ignored.

- Multi round-trip requests (MRTR) on 2026-07-28, kept stateless:
  - A 21st tool, `delete_file`, asks for confirmation before deleting (nothing is really deleted). On 2026-07-28 its first call answers `input_required` with a form elicitation, and the retry completes or is cancelled according to the answer. The `requestState` binds the confirmation to the file, so it cannot be replayed on another path. A client that does not declare form elicitation gets `MissingRequiredClientCapabilityError` (`-32021`, HTTP 400). Legacy revisions, which cannot ask, delete without asking, leaving confirmation to the client as the `destructiveHint` annotation did in 2025.
  - `_meta["com.mcp-mock/input-required"]` forces any `inputRequests` and `requestState` on a `tools/call`. The retry, recognised by its `inputResponses` or `requestState`, gets the forced result if one is given, and otherwise returns what the client answered, so a test can check its client's side of the round trip. It is refused on legacy revisions.

- Resources and prompts on every revision, declared as capabilities next to tools:
  - `resources/list` serves four fake files (JSON, Markdown, CSV and a PNG read as a base64 blob), and `resources/templates/list` three templates: `weather://{city}`, `user://{user_id}` and `file:///{path}`. `resources/read` draws on the same deterministic world as the tools, so `weather://Madrid` reads what `get_weather` reports. A missing resource is `-32002` up to 2025-11-25 and `-32602` from 2026-07-28, as each revision defines it.
  - `prompts/list` and `prompts/get` serve `summarize`, `code_review` and `weather_report`, the last one with the city's weather embedded as a resource. Unknown prompts and missing, unknown or non-string arguments are `-32602`.
  - On 2026-07-28 the list results and `resources/read` carry cache hints, and `resources/read` and `prompts/get` require the `Mcp-Name` header. Before 2025-06-18, display titles are left out.

- Progress and cancellation, with a 22nd tool, `simulate_work`, that really waits between steps:
  - A request with `_meta.progressToken` gets `notifications/progress` for each step ("Step 2 of 5"), then its result. On Streamable HTTP the response turns into an SSE stream only once there is progress to send, so a request that reports none, or an error tied to an HTTP status such as `-32021`, still gets a plain JSON response. On the 2024-11-05 transport the notifications travel on the session stream, and they carry no `message`, which that revision did not have.
  - On 2026-07-28, closing the response stream cancels the request: the server stops and sends nothing more. On the 2024-11-05 transport, `notifications/cancelled` cancels a running request of the same session, which is never answered. On the legacy Streamable HTTP revisions, without sessions to pair it with a request, `notifications/cancelled` is accepted and ignored, as the spec allows, and a dropped connection is not taken as a cancellation, as those revisions require.

### Fixed

- JSON-RPC errors whose request id cannot be read omit `id` instead of sending `id: null`, which no MCP schema allows.

[Unreleased]: https://github.com/axium-lab/mcp-mock/commits/main
