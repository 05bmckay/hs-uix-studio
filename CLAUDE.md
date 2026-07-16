# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

hs-uix Studio — a prototyping tool for HubSpot UI Extension cards. Non-developers prompt cards into existence, iterate inside HubSpot, and export three artifacts (JSON spec, markdown design doc, TSX starter) all derived from the same underlying spec.

Pre-alpha. The overall build sequence is in [`PLAN.md`](./PLAN.md) — the central technical bet is that Claude can generate a JSON spec from hs-uix type definitions, and a small renderer turns it into a faithful card.

## Repo layout

Two independent workspaces under `apps/`, plus hand-authored sample specs:

- `apps/studio-app/` — the HubSpot Project hosting the Studio app page (React, UI Extensions SDK). Entry: `src/app/pages/Pages.jsx`. No bundler config of our own; HubSpot's project CLI builds it.
- `apps/worker/` — Cloudflare Worker backend (Hono + D1 + KV + Durable Objects + AI Gateway → Anthropic). Entry: `src/index.ts`.
- `specs/` — hand-authored JSON card specs (step 1 of PLAN).
- `schema/` — reserved for the spec schema once the format stabilizes (currently empty).

The studio-app and worker don't share code — they talk over HTTP via `workerApi` in `apps/studio-app/src/app/pages/lib/worker.js`, pointing at `WORKER_URL` in `config.js`.

## Commands

### Worker (`apps/worker/`)

```bash
npm run dev            # wrangler dev — local worker at :8787
npm run deploy         # wrangler deploy
npm run typecheck      # tsc --noEmit
npm run knowledge:build  # regenerate src/tools/knowledge.generated.ts from ./knowledge/
npm run migrate:local  # apply schema.sql to local D1
npm run migrate:remote # apply schema.sql to prod D1
```

`predev`, `predeploy`, and `pretypecheck` all run `knowledge:build` automatically — you rarely need to invoke it manually. The generated file is gitignored and always rebuilt.

Secrets are set via `wrangler secret put <NAME>`; the full list is in `wrangler.toml` (`ANTHROPIC_API_KEY`, `HUBSPOT_CLIENT_ID/SECRET`, `TOKEN_ENCRYPTION_KEY`, etc.).

### Studio app (`apps/studio-app/`)

```bash
hs project dev     # local dev against the target portal with hot reload
hs project upload  # deploy the Project to the portal
```

There's no standalone test runner or linter configured in either workspace yet.

## Architecture — worker

Hono app mounted at `/`. Route modules under `src/routes/` (`oauth`, `chat`, `streams`, `projects`, `chats`, `comments`). One Durable Object: `ChatStream` (in `src/do/chat-stream.ts`) exported from `src/index.ts` — this holds long-running turn state so the UI can reconnect/poll.

- **Streaming model**: Anthropic calls run inside the Durable Object; the UI polls `/streams/:id` at `STREAM_POLL_INTERVAL_MS` for incremental output. Wall time is unbounded (DO-backed); per-invocation CPU is raised to 300s in `wrangler.toml`.
- **AI Gateway**: big conversational model runs through Anthropic via Cloudflare AI Gateway (`CLOUDFLARE_AI_GATEWAY_ID`). The `AI` binding (Workers AI) is reserved for cheap background tasks like chat-title generation.
- **Knowledge base** (`apps/worker/knowledge/`) is bundled into the worker at build time and exposed to the model through `search_knowledge`, `read_standards`, `read_block`, `read_example` tools. Three subdirectories: `standards/*.md` (design-system rules), `blocks/*.json` (prebuilt component groups), `examples/*.json` (full sample specs). Dropping a file in and running any worker command picks it up automatically — no code changes needed.
- **System prompt** lives at `apps/worker/prompts/studio_system.md` and is inlined as a string via a `[[rules]]` Text loader in `wrangler.toml` (see `src/prompts.ts`). Edit the markdown directly.
- **Storage**: D1 (`DB` binding, tables in `schema.sql` — installs, projects, specs, chats, messages, comments); KV (`OAUTH_STATE`, short-lived OAuth nonces). OAuth access/refresh tokens are AES-GCM encrypted at rest with `TOKEN_ENCRYPTION_KEY`.

## Architecture — studio-app

Single HubSpot extension page, routed client-side via `@hubspot/ui-extensions/pages`:

- `routes/HomePage.jsx` — project list.
- `routes/ProjectPage.jsx` — the workspace: chat panel left, canvas right.
- `state/projects.jsx` — `ProjectsProvider` context. Two code paths behind one hook: worker-backed when `BACKEND_ENABLED` is true (via `config.js`), otherwise in-memory seed data. Keep both paths working — the fallback is dev mode.
- `lib/worker.js` — thin HTTP client (`workerApi`, `WorkerError`). All backend calls go through here.
- `hooks/useStream.js` — subscribes to worker SSE/polling for streaming turn output.
- `components/` — chat UI pieces: `ChatPanel`, `Composer`, `CommentsPanel`, `QuestionsPanel`, `TweaksPanel`, `ExportPanel`, `PreviewToasts`.
- `renderer/` — **the spec → React renderer**. This is the step-2 bet from PLAN.md. `Canvas.jsx` is the entry; `renderNode.jsx` walks the tree; `resolve.js` handles `$`-prefixed references + `{{path}}` interpolation + expression objects (`$eq`, `$if`, `$forEach`, …); `actions.js` dispatches `$action` descriptors (e.g. `setState`); `components.js` maps spec `type` strings to real components from `@hubspot/ui-extensions` and `hs-uix`. `commentable.js` + `CommentTarget.jsx` wire up the comment-mode overlay (`commentable.js` decides which node types are comment-worthy and summarizes them for the comments feed; single-child wrapper chains collapse so only the innermost commentable shows a target).

The renderer's `Canvas` is controlled — `state`/`onStateChange` live in the parent so `TweaksPanel` and `Canvas` share one state object.

## The spec format

Hand-authored v0 — conventions documented in `specs/README.md`. Top-level shape is `{ meta, state, data, root }`. Key rules worth knowing before you touch the renderer or generate specs:

- `$state.x` / `$data.x` / `$item.x` / `$<iterVar>.x` — path references inside strings or any value position.
- `"{{path}}"` template interpolation inside string literals (produces strings only).
- Any object with a `$`-prefixed key at top level is an **expression** (`$eq`, `$gt`, `$and`, `$if`/`$then`/`$else`, …). Otherwise objects are literal props.
- `{ "$forEach": "$data.items", "as": "mode", "render": {...} }` inside a `children` array iterates.
- `onClick`/`onChange` etc. take action descriptors like `{ "$action": "setState", "key": "x", "value": "$mode.value" }`.
- **Derivation policy**: formatting, variant selection, computed booleans are **pre-computed into `data`**, not expressed in the spec. Writing `$if` chains for display text is a smell — put the resolved value in `data`. The format is intentionally narrow.

## Known issue

Studio chat stream stalls — messages stop streaming to the UI but reload recovers them. Diagnosis so far (July 2026): the server-side chain (worker → StudioRelay DO → StudioProjectAgent DO → Anthropic) was verified clean with a local curl poll harness — no gaps, turns complete. The remaining suspect was the client: `hubspot.fetch` runs through the host page's postMessage proxy and can drop a call without settling its promise, which froze `useStream.js`'s sequential poll loop forever. Poll fetches now carry a hard timeout so a dropped call retries instead of hanging. If stalls recur in HubSpot, look at the proxy leg first — not generation, not the worker.
