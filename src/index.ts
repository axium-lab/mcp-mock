import { createApp } from "./app.ts";
import { PROTECTED_PREFIX } from "./auth/index.ts";
import { loadConfig } from "./config.ts";
import { endpoints } from "./endpoints/index.ts";

const config = loadConfig();
const app = createApp();

app.listen(config.port, () => {
  const base = `http://localhost:${config.port}`;
  console.log(`mcp-mock listening on ${base}`);
  for (const endpoint of endpoints) {
    const urls = endpoint.entryPaths.map((path) => `${base}${endpoint.mountPath}${path}`);
    console.log(`- ${endpoint.name}: ${urls.join(", ")}`);
  }
  console.log(`Every endpoint is also served with OAuth under ${base}${PROTECTED_PREFIX}, e.g. ${base}${PROTECTED_PREFIX}/mcp`);
});
