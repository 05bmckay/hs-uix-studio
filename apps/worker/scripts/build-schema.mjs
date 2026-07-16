// Generates ../../schema/spec.schema.json from src/catalog.ts — the component
// and action catalog is the single source of truth, so the published JSON
// Schema is derived, never hand-edited. Run via `npm run schema:build`
// (chained into predev/predeploy alongside knowledge:build).
//
// The schema captures the structural v1 spec format: top-level shape,
// adjacency-list elements, children entries, $forEach/$render markers,
// action descriptors (with per-kind param schemas emitted from the zod
// definitions), and the watch map. Component props stay open — prop-level
// nuance lives in knowledge/standards/*.md and validate.ts, not here.

import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(here, "..");
const repoRoot = resolve(workerRoot, "../..");
const outPath = join(repoRoot, "schema", "spec.schema.json");

// catalog.ts is TypeScript + imports zod — bundle it to a temp ESM file so
// this plain-node script can import it.
const tmp = mkdtempSync(join(tmpdir(), "spec-schema-"));
const bundled = join(tmp, "catalog.mjs");
try {
  await build({
    entryPoints: [join(workerRoot, "src/catalog.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundled,
    logLevel: "silent",
  });
  const catalog = await import(pathToFileURL(bundled).href);
  const { COMPONENTS, ACTIONS } = catalog;
  const { z } = await import("zod");

  const componentNames = COMPONENTS.map((c) => c.name).sort();

  // One branch per action kind: the zod param schema (strict →
  // additionalProperties:false) with the $action discriminator injected.
  const actionBranches = Object.entries(ACTIONS).map(([kind, def]) => {
    const params = z.toJSONSchema(def.params);
    delete params.$schema;
    params.description = def.description;
    params.properties = { $action: { const: kind }, ...(params.properties ?? {}) };
    params.required = ["$action", ...(params.required ?? [])];
    return params;
  });

  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/hs-uix/hs-uix-studio/main/schema/spec.schema.json",
    title: "hs-uix Studio card spec (v1)",
    description:
      "Structural schema for Studio card specs — the { meta, state, data, root, elements } " +
      "adjacency-list format rendered by apps/studio-app's renderer. GENERATED from " +
      "apps/worker/src/catalog.ts by scripts/build-schema.mjs; do not edit by hand. " +
      "Authoring conventions ($-references, {{path}} templates, expression objects, " +
      "derivation policy) are documented in specs/README.md. Deep semantic checks " +
      "(reachability from root, action params on event props, Icon.name validity) live " +
      "in apps/worker/src/tools/validate.ts.",
    type: "object",
    required: ["root", "elements"],
    additionalProperties: false,
    properties: {
      meta: {
        type: "object",
        description: "Card metadata. Not rendered.",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          surface: { type: "string", description: "Target surface, e.g. crm.record.tab" },
          object: { type: "string", description: "Associated CRM object type" },
        },
        additionalProperties: true,
      },
      state: {
        type: "object",
        description:
          "Mutable preview state, readable as $state.<key>. Top-level keys only for $bindState and watch.",
      },
      data: {
        type: "object",
        description:
          "Static/mock data, readable as $data.<key>. Derived display values (formatting, " +
          "variant selection, computed booleans) are pre-computed here per the derivation policy.",
      },
      watch: {
        type: "object",
        description:
          "Map of state key → action(s) fired when that key's value changes (not on initial render).",
        additionalProperties: {
          anyOf: [
            { $ref: "#/$defs/action" },
            { type: "array", items: { $ref: "#/$defs/action" } },
          ],
        },
      },
      root: {
        type: "string",
        description: "Element ID of the root node; must exist as a key in elements.",
      },
      elements: {
        type: "object",
        description:
          "Adjacency-list map of unique kebab-case element ID → node. Children reference " +
          "siblings by ID string.",
        additionalProperties: { $ref: "#/$defs/node" },
      },
    },
    $defs: {
      node: {
        anyOf: [
          { $ref: "#/$defs/componentNode" },
          { $ref: "#/$defs/forEachNode" },
          { $ref: "#/$defs/renderNode" },
        ],
      },
      componentNode: {
        type: "object",
        required: ["type"],
        properties: {
          type: {
            enum: componentNames,
            description: "Component name from the catalog (apps/worker/src/catalog.ts).",
          },
          name: {
            type: "string",
            description:
              "Optional human label for structural containers; used by comment-mode outlines, not rendered.",
          },
          visible: {
            description: "Optional; node is skipped when this resolves falsy.",
          },
          children: { $ref: "#/$defs/children" },
        },
        additionalProperties: true,
      },
      children: {
        description:
          "Element ID string, text/template string, single node, or an array mixing all three " +
          "plus $forEach iteration markers. String entries that match an elements key are IDs; " +
          "otherwise they render as text.",
        anyOf: [
          { type: "string" },
          {
            type: "array",
            items: {
              anyOf: [{ type: "string" }, { $ref: "#/$defs/node" }],
            },
          },
          { $ref: "#/$defs/node" },
        ],
      },
      forEachNode: {
        type: "object",
        description:
          "Iteration marker inside a children array — renders `render` once per item of the " +
          "referenced list, exposing it as $<as>.",
        required: ["$forEach", "render"],
        properties: {
          $forEach: {
            type: "string",
            pattern: "^\\$",
            description: "Path reference to the list, e.g. $data.items.",
          },
          as: {
            type: "string",
            description: "Iteration variable name (defaults to item).",
          },
          render: { $ref: "#/$defs/node" },
        },
        additionalProperties: false,
      },
      renderNode: {
        type: "object",
        description:
          "Lazy render-callback marker for node-valued props (e.g. DataTable renderCell). " +
          "$render names the callback argument(s) exposed to the node as $-references.",
        required: ["$render", "node"],
        properties: {
          $render: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
          node: { $ref: "#/$defs/node" },
        },
        additionalProperties: false,
      },
      action: {
        description:
          "Action descriptor for event-handler props (onClick, onChange, …) and watch entries. " +
          "Param values may be literals, $-references, or expression objects.",
        anyOf: actionBranches,
      },
    },
  };

  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");
  console.log(
    `[build-schema] wrote ${outPath} (${componentNames.length} components, ${actionBranches.length} actions)`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
