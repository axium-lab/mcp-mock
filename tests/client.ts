import {
  Client,
  StreamableHTTPClientTransport,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";

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
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
