# JSON-render alignment plan

Evolve the Studio renderer + spec format to close the gap with `json-render.dev` while preserving what Studio needs (commentable overlay, preview-fidelity SDK stand-ins, pre-computed derivation discipline).

Scope: format and renderer only. Does not change Studio's product surface (HomePage, ProjectPage, chat UX) except where a phase explicitly calls it out.

## Status

**Shipped.** The streaming backbone + the spec-format modernization is done. The JSON bet is firmly validated — token economy is closed by Phase 0 + patch iteration (Phase 2), and the renderer has the primitives for progressive UI.

**What's left is tuning.** No outstanding must-do phases. The remaining items below are triggered by specific pain, not sequenced delivery.

---

## Shipped

### Phase 0 — Terser spec shape ✅

Hoisted props out of `node.props` nesting. ~25-30% token reduction. All specs migrated (3 repo + 11 examples + 22 blocks + 4 D1 rows). Renderer + exports + commentable all updated. Transitional shim still in `resolve.js` + `exports.js` — delete once you're confident no v0-shape data is at rest.

### Phase 1 — Flat `{ root, elements }` adjacency list ✅

Nodes are ID-addressable via `spec.elements[id]`. `children` arrays contain element-ID strings disambiguated from text by lookup. `$forEach.render` and `$render.node` stay inline (per-instance templates). Overlay/renderCell node-valued props stay inline.

### Phase 2 — Worker-side patch streaming ✅

Anthropic tool-call arguments now stream through a partial-spec parser that emits RFC-6902 ops as each `elements[id]` entry closes. Cards build element-by-element in the UI instead of popping in after the full tool call lands. `patch_spec` tool ops forward 1:1. Patch log persisted in DO snapshot, survives rehydrate. Client has an RFC-6902 applier. Parser is O(n) after the forward-string-tracking fix.

### Phase 4 — Catalog + Zod ✅

`apps/worker/src/catalog.ts` is the source of truth for component names, categories, descriptions, and action kinds. `validate.ts` checks specs against it (unknown component / unknown $action / bad op shape). `toPromptSection()` injects the component index into the system prompt via `{{CATALOG}}`. Studio renderer renders a visible error placeholder for unknown types instead of silent null.

### Phase 5 — `$bindState` two-way binding ✅

`{ "$bindState": "key" }` on a value prop resolves to `state.key` + auto-wires `onChange: (v) => setState("key", v)`. Explicit onChange wins. Exporter emits the pair cleanly. Closes the memory-logged `$event` workaround. Top-level state keys only in v1.

### Phase 6 — Watchers ✅

`spec.watch: { key: action | action[] }` at the spec top level. Fires on value change, skips initial mount. Dispatches via the same action pipeline as event handlers. Exporter generates a matching `useEffect` in the TSX output.

### Phase 9 — Code export utilities ✅

`specToTsx` produces a drop-in HubSpot UI extension file: React imports, state hook, watch effect, `hubspot.extend(...)` boilerplate at the bottom. Handles $bindState, $forEach, $render, $action descriptors, visibility expressions. `specToMarkdown` inline-expands v1 specs for the outline. Import collection no longer pollutes with action-variant strings.

### Phase 3 — **Skipped intentionally**

Model-emits-patches inline with prose. Reassessed after Phase 2: the headline wins (progressive build, tweak iteration cost) were already delivered by partial-parser streaming + `patch_spec` forwarding. Remaining benefit was mostly cosmetic. Cost (rewriting all 11 examples as conversation transcripts) was substantial. Not worth it.

---

## Open

Nothing urgent. Three candidate items below, ordered by likely payoff.

### Phase 7 — Input validation primitives

**What:** `validateOn: change|blur|submit`, built-in rules (`required`, `email`, `minLength`, `pattern`, `matches`), `useFieldValidation` hook. Declarative form validation without custom `$action` glue.

**Trigger:** a spec in the wild that needs validation and has to do it with imperative state + conditional Alerts. Haven't seen one yet.

**Cost:** 2-3 days. Catalog additions, render-time hook wrapping controlled inputs, error-slot convention on inputs. Only worth it once multiple specs are tripping the same pattern.

### Phase 8 — Devtools drawer

**What:** Cmd+Shift+J drawer: spec tree browser, state editor with inline `store.set`, action timeline, stream patch monitor, catalog browser, element picker via transparent `data-jr-key`. Tree-shakes in production.

**Trigger:** you want to debug a bad spec without squinting at console.log. Meaningful dev-productivity win — not user-facing.

**Cost:** 3-4 days. Separate React tree alongside Canvas, wiring into the existing action + patch flows (already well-hooked after Phase 2).

### Phase 10 — Named slots

**What:** `slots: { default: [...], extra: [...] }` replaces ad-hoc node-valued props (`Button.overlay`, `Tile.extra`, `SectionHeader.action`). Catalog declares each component's slots.

**Trigger:** overlay content loading visibly "pops in" and users complain. Or the model starts hallucinating prop names for secondary content positions and we want the catalog to constrain it.

**Cost:** high. Catalog extension (~15-20 components), per-component render shim, spec migration, example rewrite. Unlikely to be worth it unless a concrete pain drives it.

**Note:** Phase 2 patch streaming delivers most of what this would have provided for the top-level tree. Overlays remain inline-node territory and that seems fine.

---

## Not doing

### JSON Pointer in specs
Renderer keeps dotted paths (`$state.user.name`). Patches already use RFC 6901 Pointer. Translating at the boundary is cheaper than touching every reference in every spec.

### `$computed` registered functions
CLAUDE.md's derivation policy (pre-compute into `data`) is the right call for an LLM-emitted narrow format. Not opening that door.

### A2UI / Adaptive Cards protocol adapters
Out of scope until HubSpot has a reason.

### Skills format
CLAUDE.md + knowledge base already fill this role.

---

## Backlog (smaller, discovered along the way)

### Delete transitional v0-props shim
`resolve.js` + `exports.js` both have a `Transitional:` comment merging v0 `node.props` into hoisted props. Can go once you're sure nothing at rest still uses v0 shape. Grep: `Transitional:`.

### `$bindState` dotted paths
Currently top-level state keys only. `{"$bindState": "form.email"}` would need `setState` to understand nested paths. Add only if specs want nested state.

### `$bindItem` for iterated write-back
Two-way binding inside `$forEach`. Deferred until a real spec needs to mutate iterated array items.

### Per-element watchers
Today `spec.watch` is spec-level — watchers are always active. Element-level watchers (only fire while that element is mounted) haven't been needed. Add if conditional-form flows surface the gap.

### Phase-2 parser edge cases
Worth revisiting if `[chat-stream] slow parser push` warnings ever show up in `wrangler tail`. Current shape should be O(n) on all normal inputs.

### Cleanup: delete Phase 0 + Phase 1 migration scripts
`tools/migrate-spec.mjs` and `tools/migrate-spec-phase1.mjs` are one-shot. Safe to delete; kept for reference only.

### Cleanup: drop `/tmp/phase1-db-*.v0.json` backups
Four files from the Phase 1 D1 migration. Keep until you're sure nothing regressed.

---

## Things to preserve (do not regress)

- `$render` lazy markers with multi-arg name binding (`["value", "row"]`) — DataTable requires this.
- `$action: batch` — chain multiple actions from one gesture. Watchers don't replace this (watchers are state-change-triggered, batch is user-gesture-triggered).
- Pre-computed `data` vs `state` split — derivation discipline from CLAUDE.md.
- Comment-mode overlay + structural outline via optional `name` field. `isPassthroughWrapper` suppresses redundant nesting for single-child wrapper chains.
- Preview-fidelity SDK stand-ins (`studio:hsAction` CustomEvent bridge) in `renderer/actions.js`.
- Partial-spec parser forward-string-tracking (the O(n) perf fix in `lib/partial-spec.ts`). Backward-scan reverts would be O(n²) on any real spec.
