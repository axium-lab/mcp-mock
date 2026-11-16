# mcp-mock

[![Status: design phase](https://img.shields.io/badge/status-design%20phase-orange)](https://github.com/axium-lab/mcp-mock/discussions)
[![Discussions](https://img.shields.io/github/discussions/axium-lab/mcp-mock)](https://github.com/axium-lab/mcp-mock/discussions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A mock MCP server for integration tests. Point your MCP client at it, keep your code.**

> **🚧 Nothing is built yet, on purpose.** We are the team behind [llm-mock](https://github.com/axium-lab/llm-mock), and this time we want the community to shape the project before the first line of code. Tell us what you need in the [Discussions](https://github.com/axium-lab/mcp-mock/discussions).

## The problem

Testing an MCP client, host or agent today means one of three things:

- **Running the real servers** in CI, with real credentials, real side effects and real flakiness.
- **Hand-writing a fake server** for every project, which only covers the paths its author thought of.
- **Mocking the SDK** inside your own process, which tests your mocks rather than your integration.

[llm-mock](https://github.com/axium-lab/llm-mock) removes that choice for LLM provider APIs: a small server that speaks each provider's contract, with deterministic replies and no real key. mcp-mock aims to do the same for the [Model Context Protocol](https://modelcontextprotocol.io).

## What we have in mind

A server that speaks MCP faithfully enough that the official SDKs cannot tell the difference, and that a test can steer without registering anything beforehand.

This is the experience we are aiming for. **It is a sketch, not a working example:**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp")), // the only change in your app
);

const { tools } = await client.listTools();
const result = await client.callTool({ name: "echo", arguments: { text: "Hello!" } });
// result.content[0].text === "Echo: Hello!"
```

## Principles we plan to keep

These made llm-mock useful, and they are our starting point here:

- **Faithful, not a stub.** Compatibility is verified in CI with the official MCP SDKs as the clients.
- **Deterministic.** Same request, same bytes. Snapshot-test friendly.
- **Controllable from the test.** The reply a test needs travels with the request, with no setup or teardown.
- **The failure paths too.** Protocol errors, tool errors, auth rejections and timeouts are part of the contract.
- **Zero setup.** One Docker command or one `bun start`.

MCP is not a REST API, though. It has sessions, capability negotiation, server-initiated requests and two transports, so some of these principles will need a different shape. That is exactly what we want to discuss.

## What is still open

Everything below is undecided, and your input changes the outcome:

| Question | Why it matters |
| --- | --- |
| **Which side to mock?** | A mock *server* tests clients and agents. A mock *client* would test servers. We lean towards the server first. |
| **Which transports?** | Streamable HTTP, stdio, or both. The legacy HTTP+SSE transport is still in use too. |
| **Which features first?** | Tools, resources, prompts, sampling, elicitation, roots, progress, cancellation, logging, pagination, completions. |
| **How should a test control replies?** | HTTP headers as in llm-mock, `_meta` fields in the request, a fixture file, or a control endpoint. Headers do not exist over stdio. |
| **Generic server or lookalikes?** | One generic mock server, or also the tool catalogs of popular servers (GitHub, Slack, filesystem and so on). |
| **Authorization?** | Whether to simulate the OAuth flow, and how deep. |
| **Which spec revisions?** | Only the latest, or older revisions through version negotiation. |
| **How do you want to run it?** | Docker image, in-process library, `npx`/`bunx` binary, hosted instance. |

## Get involved

- **💬 [Join the kickoff discussion](https://github.com/axium-lab/mcp-mock/discussions)** and tell us how you test MCP today and where it hurts.
- **💡 Propose a feature** in the Ideas category of the Discussions.
- **⭐ Star or watch the repo** to follow the first release.

Real use cases help us most: what you are building, which SDK and transport you use, and the test you wish you could write.

## Roadmap

1. **Now:** gather use cases and settle the open questions above.
2. **Next:** publish the design and the scope of a first version.
3. **Then:** a first release, tested against the official SDKs.

## License

[MIT](LICENSE)
