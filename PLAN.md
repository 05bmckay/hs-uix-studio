# Build plan

## Target user

Non-developer HubSpot admins and solutions engineers prototyping cards to pitch internally. They never see the spec JSON — it's an intermediate representation. Their interaction is chat + inline comments in the app page.

## Scope for v1

- Per-portal Projects with an owner/creator
- Three exports: JSON spec, markdown design doc, TSX starter file
- Preview pane is the pitch surface (no "install as real card" — deferred to v2)

## Sequence

The first three steps de-risk the central technical bet:

> *Claude, given hs-uix type definitions, can generate a JSON spec that a small renderer turns into a faithful card.*

If it can't, the rest of the product has no foundation. If it can, everything else is known-good engineering.

### 1. Hand-author specs — DONE

Write JSON specs for sample cards of varied complexity. The format emerges from what these cards need to express — no schema design in the abstract.

- [x] `specs/construction-delays.json` — simple: stats, alert, chart, static list
- [x] `specs/deal-intelligence.json`, `specs/quickbooks-sync` (now in `apps/worker/knowledge/examples/`) — medium/complex coverage, plus 25+ knowledge-base examples
- [x] Conventions documented in `specs/README.md`
- [x] Format codified as JSON Schema in `schema/spec.schema.json` (generated from `apps/worker/src/catalog.ts` via `npm run schema:build`)

### 2. Minimal renderer — DONE

One React component that takes a spec and renders `@hubspot/ui-extensions` + `hs-uix` components. Lives in `apps/studio-app/src/app/pages/renderer/` (grew past "minimal": expressions, actions, watchers, `$bindState`, comment targets).

### 3. One-shot LLM generation — DONE (proven)

Claude generates valid specs server-side via the knowledge-base tools + `patch_spec`, with `validate.ts`/`repair.ts` guarding output. The central bet held.

### 4. Build the product — IN PROGRESS

- [x] Cloudflare backend: Workers + D1 + AI Gateway (LLM calls); DO-backed streaming (StudioRelay + StudioProjectAgent)
- [x] HubSpot app page: chat left, canvas right, inline comments, state tweaks
- [x] Project CRUD per-portal with owner; OAuth install flow; beta credit gating
- [x] Three export paths: JSON spec, markdown design doc, TSX starter
- [ ] Streaming-transport hardening (poll-timeout fix shipped July 2026 — verify in HubSpot)
- [ ] Cost: per-turn input tokens are heavy (~280k/turn observed) — prompt caching via native Anthropic API is the candidate fix
- [ ] Progressive canvas preview: patch events currently arrive in bulk at round end for big creation patches
