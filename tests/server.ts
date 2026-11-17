import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";

export interface RunningServer {
  server: Server;
  origin: string;
}

// Mounts the app on an ephemeral port. Each endpoint's tests build their own
// MCP client on top of the returned origin.
export async function startServer(): Promise<RunningServer> {
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const started: Server = app.listen(0, () => resolve(started));
  });
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

export function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
