#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const id = process.argv[2];
if (!id) {
  console.error("usage: npm run d1:delete-project -- <project-id>");
  console.error("       (run `npm run d1:projects` to list)");
  process.exit(1);
}
if (!/^p-[a-f0-9-]+$/i.test(id)) {
  console.error(`refusing to delete: "${id}" does not look like a project id (expected p-<uuid>)`);
  process.exit(1);
}

const sql = `DELETE FROM projects WHERE id = '${id}'`;
const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "studio", "--remote", "--command", sql],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
