#!/usr/bin/env node
// Phase 1: flatten nested spec trees into { root, elements: { id: node } }.
//
//   node tools/migrate-spec-phase1.mjs specs/*.json apps/worker/knowledge/examples/*.json
//
// Prereq: specs already migrated to Phase 0 (hoisted props).
//
// Shape rules:
//   - Only `children` arrays are flattened. Node-valued props (overlay,
//     renderCell.node, etc.) stay inline.
//   - $forEach.render and $render.node stay inline — they're per-instance
//     templates, not ID-addressable.
//   - ID source: node.name if present; otherwise `${type}-${counter}`.
//     Uniqueness enforced per spec.
//   - In children arrays: objects are flattened (replaced by their IDs);
//     strings stay as-is (they're text/interpolation/$ref — the renderer
//     disambiguates at render time by looking up in elements).

import { readFile, writeFile } from "node:fs/promises";
import { argv, exit } from "node:process";

const files = argv.slice(2);
if (!files.length) {
  console.error("usage: migrate-spec-phase1.mjs <file.json> [...]");
  exit(1);
}

function isInlineTemplate(node) {
  if (!node || typeof node !== "object") return false;
  return "$forEach" in node || "$render" in node;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "node";
}

function assignId(node, usedIds) {
  const base = node.name ? slugify(node.name) : slugify(node.type || "node");
  let id = base;
  let n = 1;
  while (usedIds.has(id)) id = `${base}-${n++}`;
  usedIds.add(id);
  return id;
}

// Returns an ID to stand in for `node` in a children array; mutates elements.
// If node is an inline template ($forEach/$render) or primitive, returns the
// unchanged entry (so callers keep it inline in the children array).
function flattenNode(node, elements, usedIds) {
  if (node === null || node === undefined) return node;
  if (typeof node !== "object") return node;
  if (Array.isArray(node)) return node; // unusual but leave alone
  if (isInlineTemplate(node)) {
    // Recurse into the inline template so nested children arrays also get flattened.
    return walkInline(node, elements, usedIds);
  }

  const id = assignId(node, usedIds);
  const out = { ...node };
  if ("children" in out) out.children = flattenChildren(out.children, elements, usedIds);
  // $forEach.render lives inline but its inner tree still needs children-flatten.
  elements[id] = out;
  return id;
}

function flattenChildren(children, elements, usedIds) {
  if (children === null || children === undefined) return children;
  if (typeof children === "string") return children; // text/ref — leave
  if (Array.isArray(children)) {
    return children.map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object") return flattenNode(c, elements, usedIds);
      return c;
    });
  }
  // Single-node form — flatten to an ID too (single-string children is still
  // allowed above, so an ID-string here is unambiguous).
  if (typeof children === "object") {
    return flattenNode(children, elements, usedIds);
  }
  return children;
}

// Walks an inline template ($forEach, $render) without flattening the template
// itself; recurses into children/render so nested references flatten properly.
function walkInline(node, elements, usedIds) {
  const out = { ...node };
  if ("render" in out) {
    const inner = out.render;
    if (inner && typeof inner === "object" && !isInlineTemplate(inner)) {
      // The render target IS a node — flatten its subtree via children, but
      // keep the template itself inline (don't emit a root ID for it).
      // Strategy: treat render as a "local root" — it keeps its own shape,
      // and its children get flattened into `elements`.
      const rendered = { ...inner };
      if ("children" in rendered) {
        rendered.children = flattenChildren(rendered.children, elements, usedIds);
      }
      out.render = rendered;
    } else if (inner && typeof inner === "object") {
      out.render = walkInline(inner, elements, usedIds);
    }
  }
  if ("node" in out && out.node && typeof out.node === "object") {
    // $render marker — its node is also an inline template (per-row).
    const inner = out.node;
    if (!isInlineTemplate(inner)) {
      const rendered = { ...inner };
      if ("children" in rendered) {
        rendered.children = flattenChildren(rendered.children, elements, usedIds);
      }
      out.node = rendered;
    }
  }
  return out;
}

function migrateSpec(spec) {
  if (!spec || typeof spec !== "object") return spec;

  // Already v1? Detect by presence of `elements` map with string root ref.
  if (spec.elements && typeof spec.root === "string") return spec;

  const out = { ...spec };
  const elements = {};
  const usedIds = new Set();

  // Full specs: top-level `root` is a node → flatten into elements, replace
  // with an ID string.
  if (spec.root && typeof spec.root === "object") {
    // Prefer `root` itself as the root ID when the node doesn't suggest one.
    if (!spec.root.name) {
      usedIds.add("root");
      const rootNode = { ...spec.root };
      if ("children" in rootNode) {
        rootNode.children = flattenChildren(rootNode.children, elements, usedIds);
      }
      elements["root"] = rootNode;
      out.root = "root";
    } else {
      const rootId = flattenNode(spec.root, elements, usedIds);
      out.root = rootId;
    }
    out.elements = elements;
    return out;
  }

  // Knowledge blocks: shape is { node: ... } not { root: ... }. Leave the
  // `node` field in place but flatten any children arrays. Blocks are
  // fragments, not full specs — we don't emit a root/elements pair for them.
  if (spec.node && typeof spec.node === "object") {
    const rootNode = { ...spec.node };
    // For blocks, we DO flatten into an elements map to match spec shape so
    // the renderer treats them uniformly when inlined.
    const blockElements = {};
    const blockUsed = new Set();
    if (!rootNode.name) {
      blockUsed.add("root");
      const copy = { ...rootNode };
      if ("children" in copy) {
        copy.children = flattenChildren(copy.children, blockElements, blockUsed);
      }
      blockElements["root"] = copy;
      out.node = { root: "root", elements: blockElements };
    } else {
      const rid = flattenNode(rootNode, blockElements, blockUsed);
      out.node = { root: rid, elements: blockElements };
    }
    return out;
  }

  return spec;
}

let hadError = false;
for (const file of files) {
  try {
    const raw = await readFile(file, "utf8");
    const spec = JSON.parse(raw);
    const migrated = migrateSpec(spec);
    await writeFile(file, JSON.stringify(migrated, null, 2) + "\n", "utf8");
    const count = Object.keys(migrated.elements || migrated.node?.elements || {}).length;
    console.log(`migrated ${file}  (${count} elements)`);
  } catch (err) {
    console.error(`! ${file}: ${err.message}`);
    hadError = true;
  }
}
exit(hadError ? 1 : 0);
