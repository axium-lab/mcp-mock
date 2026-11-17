# Contributing

mcp-mock follows the structure of [llm-mock](https://github.com/axium-lab/llm-mock). These rules keep it that way.

## Getting started

```bash
bun install
bun run dev        # http://localhost:3000, restarts on change
bun test           # official MCP SDK + schema validation
bun run typecheck
```

The server also runs on Node 22.18 or later, with no build step: `npm run start:node`.

## Layout

```
src/
  core/        transport- and revision-agnostic mechanisms (JSON-RPC, revisions, HTTP fallbacks)
  tools/       the tool catalog, independent of any revision: calc/ (real computations),
               world/ (deterministic fake data), the hash engine and the argument validator
  resources/   the resource catalog, reading from the same fake world as the tools
  prompts/     the prompt catalog
  tasks/       the tasks extension's stateless task ids
  auth/        OAuth for /protected: the resource server check and a stateless authorization server
  endpoints/   one self-contained router per pinned revision, plus the dual-era /mcp
  app.ts       builds the Express app without listening, for tests
  index.ts     entry point
schemas/       official schema.json per revision, vendored by `bun run schemas:fetch`
tests/         integration tests with the official SDK as the client
```

## Rules

- **`core/` never imports from `endpoints/`.** It holds mechanisms every revision shares and knows nothing about any one of them.
- **Each endpoint is self-contained.** It owns its paths, transport and revision quirks. Adding an endpoint never touches another one.
- **Reuse, don't copy.** When a revision did not change something, its endpoint imports the newer revision's code for it. Shared code moves to a common module only when two endpoints share the exact same wire behavior, never with a single consumer.
- **Only routers know about HTTP.** Protocol logic (handlers, payload builders) never imports Express, so it can serve stdio later.
- **Deterministic.** No `Math.random()`, no `Date.now()` in responses. The same request returns the same bytes. Two exceptions depend on the clock: the tasks extension (`src/tasks/`), whose status depends on the time passed since a task started and whose timestamps are real, and OAuth (`src/auth/`), whose codes and tokens expire. Results themselves are never affected.
- **Stateless tools.** A tool's result depends only on its arguments.
- **One exception to statelessness.** The 2024-11-05 HTTP+SSE transport (`src/endpoints/2024-11-05/`) cannot work without pairing each POST with its open stream, so it keeps open streams in memory by session id, and forgets them when the connection closes. Nothing else in the mock keeps state between requests.
- **The hash is a contract.** Fake-world data comes from `src/tools/hash.ts`. Changing the hash, the generator or the order in which a tool draws values changes responses users may have snapshotted, so it is a breaking change. The snapshots in `tests/endpoints/__snapshots__/` catch it.
- **Node-compatible source.** Relative imports carry their `.ts` extension, only erasable TypeScript syntax (no enums, namespaces or constructor parameter properties), and no `Bun.*` APIs in `src/`. Tests may use `bun:test`.

## Tests

Every endpoint is tested through the official TypeScript SDK client (`tests/client.ts`), and the messages it produces are validated against the official schema of its revision (`tests/schema.ts`). A behavior the SDK cannot reach (malformed input, wrong headers) is tested with plain `fetch`.

## Style

2 spaces, double quotes, semicolons, around 100 columns. Comments are in English and explain why, or how the real protocol behaves, not what the code does.

## Changelog

[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org). Add your change under `[Unreleased]`, and keep the comparison links at the bottom up to date.
