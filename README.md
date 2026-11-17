# mcp-mock

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A mock MCP server for integration tests. Point your MCP client at it, keep your code.**

mcp-mock speaks the [Model Context Protocol](https://modelcontextprotocol.io) faithfully enough that the official SDKs cannot tell it from a real server, in every spec revision from 2024-11-05 to 2026-07-28. Its tools return deterministic, believable data, and a test can force any answer, error or HTTP failure from the request itself, with nothing to register beforehand.

From the team behind [llm-mock](https://github.com/axium-lab/llm-mock).

## Quick start

```bash
docker run --rm -p 3000:3000 ghcr.io/axium-lab/mcp-mock:0.1.0
```

See [Docker](#docker) for the available tags. Or from a clone of this repository:

```bash
bun install
bun start            # or, without Bun: npm install && npm run start:node (Node 22.18+)
```

Then point your client at `http://localhost:3000/mcp`:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp")));

const result = await client.callTool({ name: "get_weather", arguments: { city: "Madrid" } });
// result.structuredContent → { city: "Madrid", temperature: 14, conditions: "thunderstorm", … }
// Same call, same bytes, every time, on any machine.
```

## Endpoints

| URL | Serves |
| --- | --- |
| `/mcp` | Any client. Each request is served in the era it opens with: a request carrying the 2026-07-28 `_meta` envelope as 2026-07-28, an `initialize` as the legacy revision it negotiates. Use this one unless you need to pin a revision. |
| `/2026-07-28/mcp` | Only 2026-07-28, the stateless revision. |
| `/2025-11-25/mcp`, `/2025-06-18/mcp`, `/2025-03-26/mcp` | Only that legacy revision, over Streamable HTTP. |
| `/2024-11-05/sse`, `/sse` | The deprecated HTTP+SSE transport. The pinned one speaks only 2024-11-05; the root one negotiates any legacy revision. |
| `/protected/…` | Every endpoint above again, behind OAuth. See [OAuth](#oauth). |
| `/health` | `{ "status": "ok", "version": "…" }` |

A pinned endpoint is how you test what your client does when a server only speaks one revision, which is hard to reproduce against real servers.

## What it serves

### Tools

22 tools, listed in this order on every revision.

**Real computations:** `echo`, `add`, `calculate` (a safe arithmetic parser), `transform_text`, `text_stats`, `sort_list`, `convert_units`, `hash_text`, `date_diff`, `color_swatch` (a real PNG) and `simulate_work` (waits between steps; for progress, timeouts, cancellation and tasks).

**Fake world:** data derived from a hash of the normalized arguments, so the same call always returns the same data and different calls return different, internally consistent data (metric and imperial agree, currency conversions round-trip, a 3-day forecast is the start of the 7-day one).

| Tool | Fails on purpose with |
| --- | --- |
| `get_weather`, `get_forecast` | `city: "Atlantis"` |
| `geocode` | `address: "Atlantis"` |
| `search_web` | `query: "error"` |
| `get_stock_price` | `symbol: "XXXX"` |
| `convert_currency` | `from` or `to`: `"XXX"` |
| `get_user` | `user_id: "missing"` |
| `get_flight_status` | `flight_number: "XX000"` |
| `read_file`, `delete_file` | `path: "/missing"` |
| `send_email` | `to: "bounce@example.com"` |

Arguments are normalized before hashing and matching: `" madrid "` and `"Madrid"` are the same city. Results use every content type: text, structured content with an output schema, `image`, `resource_link` and embedded `resource`.

`delete_file` asks for confirmation through a multi round-trip request on 2026-07-28 (nothing is really deleted).

### Resources and prompts

- **Resources:** `file:///etc/app/config.json`, `file:///docs/README.md`, `file:///data/report.csv`, `file:///images/logo.png` (a binary blob), and the templates `weather://{city}`, `user://{user_id}` and `file:///{path}`, drawn from the same fake world as the tools.
- **Prompts:** `summarize`, `code_review` and `weather_report`, the last with the city's weather embedded as a resource.

## Controlling answers from the test

Each request carries what its own answer must be: identical requests always get identical answers, and nothing is shared between requests.

| Control | Effect |
| --- | --- |
| `_meta["com.mcp-mock/response"]` on `tools/call` | Replaces the result with the given `text`, `content`, `structuredContent` and `isError`, for any tool name. Adapted to each revision's format. |
| `_meta["com.mcp-mock/error"]` on any request | Fails it with the given JSON-RPC `code`, `message` and `data`. |
| `_meta["com.mcp-mock/input-required"]` on `tools/call` (2026-07-28) | Answers `input_required` with the given `inputRequests` and `requestState`; the retry returns what your client answered. |
| `_meta["com.mcp-mock/notifications"]` on `subscriptions/listen` or `resources/subscribe` | Scripts the change notifications the stream delivers (`events`, `intervalMs`, `close`). |
| `_meta["com.mcp-mock/task"]` on `tools/call` (2026-07-28) | Makes a task of the call (`durationMs`), for clients that declare the tasks extension. |
| `x-mcp-mock-status: 503` header | Forces an HTTP failure from 400 to 599 on any endpoint; `429` adds `Retry-After`. |

```ts
await client.callTool({
  name: "get_weather",
  arguments: { city: "Madrid" },
  _meta: { "com.mcp-mock/response": { structuredContent: { city: "Madrid", temperature: 40 } } },
});
```

## Faithful to each revision

What differs between revisions differs on the wire too, for example:

| | 2024-11-05 | 2025-03-26 | 2025-06-18 | 2025-11-25 | 2026-07-28 |
| --- | --- | --- | --- | --- | --- |
| Transport | HTTP+SSE | Streamable HTTP | Streamable HTTP | Streamable HTTP | Streamable HTTP, stateless |
| Handshake | `initialize` | `initialize` | `initialize` | `initialize` | none: `_meta` on every request, `server/discover` |
| JSON-RPC batches | no | yes | no | no | no |
| Structured content, resource links, titles | no | no | yes | yes | yes |
| Invalid tool arguments | protocol error | protocol error | protocol error | `isError` result | `isError` result |
| Resource not found | `-32002` | `-32002` | `-32002` | `-32002` | `-32602` |

Every message the mock sends is validated in its test suite against the official `schema.json` of its revision, and every endpoint is exercised through the official TypeScript SDK as the client.

On 2026-07-28 the mock also serves multi round-trip requests, progress over SSE, cancellation by closing the stream, `subscriptions/listen`, and the tasks extension (`io.modelcontextprotocol/tasks`). Legacy revisions are served without sessions, which the spec allows, so they keep no state between requests.

## OAuth

Authorization is opt-in by URL: everything under `/protected/` requires a bearer token, and everything else stays open. The mock is its own authorization server, on the same origin:

- `401` with `WWW-Authenticate` pointing at the Protected Resource Metadata (RFC 9728) of each protected endpoint.
- Authorization server metadata at `/.well-known/oauth-authorization-server` (and as OpenID Connect discovery).
- `/oauth/authorize` approves at once and redirects back with `code` and `iss`; `/oauth/token` handles the authorization code grant with PKCE S256 and refresh tokens; `/oauth/register` handles Dynamic Client Registration.
- Tokens must be issued for the very endpoint they are used on, and carry the `mcp` scope (`403 insufficient_scope` otherwise).
- To provoke failures: the `mcp-mock:deny` scope makes the user deny access, and `mcp_mock_expires_in` on the token endpoint issues tokens that expire when you want.

The official SDK's OAuth flow runs end to end against it. Codes and tokens are signed with a fixed, public key and are not single-use: this is a test double, not an authorization server for real users.

## Docker

Every [release](https://github.com/axium-lab/mcp-mock/releases) publishes an image to the GitHub Container Registry, for `linux/amd64` and `linux/arm64`. No login is needed to pull it:

```bash
docker pull ghcr.io/axium-lab/mcp-mock:0.1.0
```

| Tag | Points to |
| --- | --- |
| `0.1.0` | That exact release. Pin this one in CI so your tests don't change under you. |
| `0.1` | The latest patch release of 0.1. |
| `latest` | The latest release. |

The container listens on port 3000 and reports its state to Docker through `/health`. To serve on another port, change both sides:

```bash
docker run --rm -p 8080:8080 -e MCP_MOCK_PORT=8080 ghcr.io/axium-lab/mcp-mock:0.1.0
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_MOCK_PORT` (or `PORT`) | `3000` | Port to listen on. |

## Not supported yet

stdio, `Origin` header validation, and sessions on the legacy revisions. Tell us what you need in the [Discussions](https://github.com/axium-lab/mcp-mock/discussions).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [CHANGELOG](CHANGELOG.md).

## License

[MIT](LICENSE)
