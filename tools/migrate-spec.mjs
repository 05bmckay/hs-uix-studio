#!/usr/bin/env node
// One-off: hoist `props` up onto nodes so specs drop the `{"props": {...}}`
// wrapping. Reads JSON from argv files in place.
//
//   node tools/migrate-spec.mjs specs/*.json apps/worker/knowledge/examples/*.json
//
// Safe to re-run: nodes that already have no `props` key are left alone.

import { readFile, writeFile } from "node:fs/promises";
import { argv, exit } from "node:process";

const files = argv.slice(2);
if (!files.length) {
  console.error("usage: migrate-spec.mjs <file.json> [...]");
  exit(1);
}

// Reserved on a component node. Does NOT include top-level spec keys
// (meta/state/data/root) — those only appear on the spec, not on nodes,
// and `data` is a legitimate prop name on charts.
const RESERVED = new Set([
  "type", "children", "visible", "name",
  "$forEach", "as", "render",
]);

function migrateNode(node) {
  if (Array.isArray(node)) return node.map(migrateNode);
  if (!node || typeof node !== "object") return node;

  // Hoist legacy props onto the node.
  const out = {};
  const props = node.props && typeof node.props === "object" ? node.props : null;

  // Preserve key order roughly: type, name, <hoisted props>, visible, children.
  if ("type" in node) out.type = node.type;
  if ("name" in node) out.name = node.name;

  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (RESERVED.has(k)) {
        console.warn(`! prop "${k}" collides with reserved key — skipped`);
        continue;
      }
      out[k] = migrateNode(v);
    }
  }

  // Copy any non-reserved, non-props keys already present at the top level
  // (iteration wrappers, already-hoisted props from re-runs).
  for (const [k, v] of Object.entries(node)) {
    if (k === "type" || k === "name" || k === "props") continue;
    if (k === "visible" || k === "children") continue;
    out[k] = migrateNode(v);
  }

  if ("visible" in node) out.visible = migrateNode(node.visible);
  if ("children" in node) out.children = migrateNode(node.children);

  return out;
}

function migrateSpec(spec) {
  if (!spec || typeof spec !== "object") return spec;
  const out = { ...spec };
  // Full specs use `root`; knowledge blocks wrap a single node under `node`.
  if (spec.root) out.root = migrateNode(spec.root);
  if (spec.node) out.node = migrateNode(spec.node);
  return out;
}

for (const file of files) {
  const raw = await readFile(file, "utf8");
  const spec = JSON.parse(raw);
  const migrated = migrateSpec(spec);
  await writeFile(file, JSON.stringify(migrated, null, 2) + "\n", "utf8");
  console.log(`migrated ${file}`);
}
