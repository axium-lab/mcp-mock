import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";

// A legacy client on the deprecated 2024-11-05 HTTP+SSE transport.
export async function connectSseClient(url: string, supportedProtocolVersions?: string[]): Promise<Client> {
  const client = new Client(
    { name: "mcp-mock-tests", version: "0.0.0" },
    {
      versionNegotiation: { mode: "legacy" },
      ...(supportedProtocolVersions ? { supportedProtocolVersions } : {}),
    },
  );
  await client.connect(new SSEClientTransport(new URL(url)));
  return client;
}

// Builds an official TypeScript SDK client (v2) aimed at one endpoint. The v2
// client speaks every revision mcp-mock serves, so it is the CI client for all
// of them:
// - { pin: "2026-07-28" }: modern era, exactly that revision.
// - "legacy": the 2025 initialize handshake; `supportedProtocolVersions`
//   narrows it to the legacy revision under test.
// - "auto": probes with server/discover and falls back to legacy, the
//   dual-era client the /mcp endpoint has to satisfy.
// 2024-11-05 uses the SDK's SSEClientTransport instead of Streamable HTTP.
export interface ClientOptions {
  mode: VersionNegotiationMode;
  supportedProtocolVersions?: string[];
  fetch?: typeof fetch;
}

export async function connectClient(url: string, options: ClientOptions): Promise<Client> {
  const client = new Client(
    { name: "mcp-mock-tests", version: "0.0.0" },
    {
      versionNegotiation: { mode: options.mode },
      ...(options.supportedProtocolVersions
        ? { supportedProtocolVersions: options.supportedProtocolVersions }
        : {}),
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), options.fetch ? { fetch: options.fetch } : {}),
  );
  return client;
}

// A fetch that records every JSON body the server answers with, so a test
// driven through the SDK can still check the exact bytes against the schema.
export function recordingFetch(): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const recording = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await fetch(input, init);
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      bodies.push(await res.clone().json());
    }
    return res;
  }) as typeof fetch;
  return { fetch: recording, bodies };
}
