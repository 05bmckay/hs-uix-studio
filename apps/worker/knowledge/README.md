# Studio knowledge base

Everything in this directory is bundled into the worker at build time and made available to Studio (the AI) through the `search_knowledge`, `read_standards`, `read_block`, and `read_example` tools.

**Adding new knowledge is intentionally frictionless.** Drop a file in the right subdirectory, run any worker command (`npm run dev`, `npm run deploy`, `npm run typecheck`), and the auto-generated manifest picks it up. No TypeScript edits required.

## Structure

```
knowledge/
  standards/            Markdown docs — the design-system rule book
    *.md                one file per topic (tables.md, forms.md, kanban.md, utils.md, …)
    COPIED_FROM.md      provenance note — skipped by the bundler
  blocks/               Prebuilt JSON component groups
    *.json              one block per file, { name, description, node, ... }
  examples/             Full sample card specs
    *.json              one card per file, standard spec shape
```

## File conventions

### `standards/*.md`

Plain markdown. Keep files focused — one topic each. Studio will pull 1–2 at a time when building something, so shorter + more targeted beats one monolithic doc.

### `blocks/*.json`

```jsonc
{
  "name": "stats-row",                                    // unique, kebab-case
  "description": "One-liner explaining when to use it",   // shows in search
  "componentsUsed": ["Statistics", "StatisticsItem"],     // for search
  "dataShape": { ... },                                   // optional: what data.* keys to populate
  "node": { /* a standalone spec node, ready to drop in */ }
}
```

The `node` is composable — Studio can splice it into a `root.children` array or wire it inside a branch.

### `examples/*.json`

Full spec — `{ meta, state, data, root }`. Used as references, not copy-paste targets. A good example teaches:
- Derivation style (precomputed values in `data`, no `$if` chains in the spec)
- View-mode gating (`visible` + `$state.viewMode`)
- Naming on structural containers
- Block composition where applicable

## The build script

`scripts/build-knowledge.mjs` scans this directory and writes `src/tools/knowledge.generated.ts`. It runs automatically on `predev`, `predeploy`, and `pretypecheck`. You can also run it manually: `npm run knowledge:build`.

The generated file is gitignored — it's always rebuilt.
