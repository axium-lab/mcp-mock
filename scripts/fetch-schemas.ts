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

// The official extensions the mock implements, from their own repositories.
const EXTENSIONS = [
  {
    path: "schemas/extensions/tasks/schema.json",
    url: "https://raw.githubusercontent.com/modelcontextprotocol/ext-tasks/main/schema/2026-07-28/schema.json",
  },
];

for (const { path, url } of EXTENSIONS) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, `${JSON.stringify(await res.json(), null, 2)}\n`);
  console.log(path);
}
