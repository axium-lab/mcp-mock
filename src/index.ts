import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { endpoints } from "./endpoints/index.ts";

const config = loadConfig();
const app = createApp();

app.listen(config.port, () => {
  console.log(`mcp-mock listening on http://localhost:${config.port}`);
  for (const endpoint of endpoints) {
    const urls = endpoint.entryPaths.map((path) => `http://localhost:${config.port}${endpoint.mountPath}${path}`);
    console.log(`- ${endpoint.name}: ${urls.join(", ")}`);
  }
});
