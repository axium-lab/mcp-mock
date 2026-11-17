import { mkdir, writeFile } from "node:fs/promises";
import { REVISIONS } from "../src/core/revisions.ts";

// Vendors the official schema.json of every supported revision into
// schemas/<revision>/schema.json. The files are committed so tests run offline
// and a spec fix upstream shows up as a reviewable diff, not a silent change.
const SOURCE =
  "https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema";

for (const { id } of REVISIONS) {
  const res = await fetch(`${SOURCE}/${id}/schema.json`);
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  const schema = await res.json();
  await mkdir(`schemas/${id}`, { recursive: true });
  await writeFile(`schemas/${id}/schema.json`, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`schemas/${id}/schema.json`);
}
