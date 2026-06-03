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

### 1. Hand-author specs (current step)

Write JSON specs for sample cards of varied complexity. The format emerges from what these cards need to express — no schema design in the abstract.

- [ ] `specs/construction-delays.json` — simple: stats, alert, chart, static list
- [ ] `specs/fleet-maintenance.json` — medium: DescriptionList, Alert, DataTable, Panel form overlay
- [ ] `specs/quickbooks-sync.json` — complex: tabs-in-tabs, two detail panels, toggle mutations, aggregated stats

Exit criterion: three specs authored, conventions documented in `specs/README.md`. When the format stabilizes, codify it in `schema/`.

### 2. Minimal renderer

One React component that takes a spec and renders `@hubspot/ui-extensions` + `hs-uix` components. Lives in a small test HubSpot card extension. Feed it the step-1 specs; iterate until visual fidelity is acceptable.

Exit criterion: all step-1 specs render acceptably in the actual HubSpot sandbox.

### 3. One-shot LLM generation

Standalone Anthropic API script. Dump hs-uix + relevant `@hubspot/ui-extensions` `.d.ts` files into the system prompt. Generate specs for 5–10 varied natural-language prompts. Pipe each through the renderer.

Exit criterion: Claude generates consistently valid, renderable specs. The central bet is proven.

### 4. Build the product

- Cloudflare backend: Workers + D1 (project metadata) + R2 (specs, artifacts) + AI Gateway (LLM calls)
- HubSpot app page: chat left, canvas right, inline comments, state toggle
- Project CRUD per-portal with owner
- Spec → markdown and spec → tsx generation
- Three export paths
