# hs-uix Studio

hs-uix Studio is a prototyping workspace for HubSpot UI Extension cards. It lets HubSpot admins, solutions engineers, and product teams describe a card in natural language, iterate on it in a chat-driven workspace, preview the result in HubSpot, and export implementation-ready artifacts for engineering.

The product is currently pre-alpha. The core bet is that an LLM can generate a narrow JSON card spec, and a small renderer can turn that spec into a faithful UI Extension card using [`hs-uix`](https://github.com/05bmckay/hs-uix) and `@hubspot/ui-extensions` components.

## What it does

A Studio project gives you a single place to:

- **Prompt a card into existence** — describe the card, data, layout, actions, and edge cases in chat.
- **Preview the card** — render the generated JSON spec through the Studio renderer inside the HubSpot UI Extensions environment.
- **Iterate with comments and tweaks** — use chat, comment mode, clarifying questions, and state controls to refine the card.
- **Export deliverables** — produce three artifacts from the same source spec:
  - JSON spec for reopening or sharing the prototype
  - Markdown design doc for handoff
  - TSX starter file for a production UI Extension implementation

Studio is not trying to install generated cards directly into production HubSpot accounts yet. The v1 goal is a high-fidelity prototype and handoff tool.

## How it works

At a high level:

1. The user opens the Studio app page in HubSpot.
2. The app lists portal-scoped Studio projects from the backend.
3. Inside a project, the user chats with the AI assistant.
4. The Cloudflare Worker routes the turn to a Durable Object-backed project agent.
5. The agent uses the Studio system prompt, bundled knowledge base, validation tools, and LLM calls to create or patch a JSON spec.
6. The HubSpot app polls the worker for stream updates and receives incremental text/spec changes.
7. The React renderer turns the spec into real `hs-uix` / `@hubspot/ui-extensions` components on the canvas.
8. Export routes derive markdown and TSX artifacts from the current spec.

The important design decision is that the **JSON spec is the source of truth**. The preview, design doc, and TSX starter are all derived from that same spec so they stay aligned.

## Repository layout

```txt
hs-uix-studio/
├── README.md
├── CLAUDE.md                     # repo guidance for coding agents
├── PLAN.md                       # high-level build plan and product scope
├── JSON_RENDER_PLAN.md           # renderer/spec notes
├── claude_system_prompt.md       # prompt reference / scratch material
├── schema/                       # reserved for JSON schema once the spec stabilizes
├── scripts/                      # repo-level helper scripts
├── specs/                        # hand-authored sample card specs and spec docs
└── apps/
    ├── studio-app/               # HubSpot Project app page
    │   ├── hsproject.json
    │   └── src/app/pages/
    │       ├── Pages.jsx         # HubSpot page entry / router
    │       ├── config.js         # worker URL and backend toggle
    │       ├── routes/           # Home, Project, Settings, NotFound pages
    │       ├── components/       # chat, comments, questions, tweaks, exports
    │       ├── renderer/         # JSON spec → React component renderer
    │       ├── hooks/            # stream/effect hooks
    │       ├── lib/              # worker client + services/effects
    │       └── state/            # project state provider
    └── worker/                   # Cloudflare Worker backend
        ├── src/
        │   ├── index.ts          # Hono app and route mounting
        │   ├── routes/           # oauth, projects, chat, streams, comments, export, etc.
        │   ├── agents/           # Durable Object project agent
        │   ├── do/               # stream/export relay Durable Objects
        │   ├── lib/              # auth, db, crypto, LLM, patch, verify helpers
        │   ├── tools/            # model tools: knowledge, lint, repair, validate
        │   └── prompts.ts        # prompt imports
        ├── knowledge/            # bundled standards, blocks, and examples for the model
        ├── prompts/              # Studio system prompt markdown
        ├── schema.sql            # D1 database schema
        ├── wrangler.toml         # Cloudflare bindings, vars, migrations
        └── package.json
```

## Main workspaces

### `apps/studio-app`

The HubSpot UI Extension project that users interact with. It is a React app page built and served by the HubSpot project CLI.

Key parts:

- `routes/HomePage.jsx` — project list and creation flow.
- `routes/ProjectPage.jsx` — main workspace with chat on the left and canvas on the right.
- `routes/SettingsPage.jsx` — settings and usage surface.
- `state/projects.jsx` — project context with both worker-backed and mock/in-memory paths.
- `lib/worker.js` — thin HTTP client; all backend calls go through here.
- `hooks/useStream.js` — subscribes to backend stream/polling updates.
- `renderer/Canvas.jsx` — renderer entry point.
- `renderer/renderNode.jsx` — walks the spec tree and renders components.
- `renderer/resolve.js` — resolves `$state`, `$data`, `$item`, templates, and expression objects.
- `renderer/actions.js` — dispatches spec action descriptors such as `setState`.
- `renderer/commentable.js` and `CommentTarget.jsx` — comment-mode overlay support.

Runtime backend configuration lives in `apps/studio-app/src/app/pages/config.js`:

```js
export const WORKER_URL = "https://...";
export const BACKEND_ENABLED = Boolean(WORKER_URL);
```

Set `WORKER_URL` to an empty string to use the local mock path, `http://localhost:8787` for `wrangler dev`, or the deployed worker URL for a real backend.

### `apps/worker`

The Cloudflare Worker backend. It uses:

- **Hono** for HTTP routing.
- **D1** for installs, projects, specs, chats, messages, comments, and usage data.
- **KV** for short-lived OAuth state nonces.
- **Durable Objects** for long-running project-agent work and stream/export relays.
- **Cloudflare AI Gateway** for model calls.
- **Workers AI** for cheaper background tasks where useful.
- **Bundled knowledge files** for design standards, reusable blocks, and examples exposed to the model as tools.

Routes are mounted from `src/index.ts`:

- `/oauth` — HubSpot OAuth install/callback flow.
- `/projects` — project CRUD and current spec storage.
- `/chats` — chat thread/message history.
- `/chat` — start or continue AI turns.
- `/streams` — polling/reconnect stream endpoints.
- `/comments` — inline prototype comments.
- `/export` — generated JSON/markdown/TSX artifact flows.
- `/knowledge` — knowledge-base inspection endpoints.
- `/usage` — usage/settings data.
- `/debug` — development diagnostics.

## The JSON spec format

The current spec format is hand-authored v0 and documented in [`specs/README.md`](./specs/README.md). Top-level specs generally look like:

```json
{
  "meta": { "name": "...", "description": "..." },
  "state": { "viewMode": "summary" },
  "data": { "items": [] },
  "root": "card-root",
  "elements": {
    "card-root": {
      "type": "Flex",
      "direction": "column",
      "children": ["header", "body"]
    }
  }
}
```

Important conventions:

- `root` points to an element ID in `elements`.
- Element nodes use a top-level `type` plus component props.
- `children` can contain element IDs, strings, or special inline render markers.
- `$state.x`, `$data.x`, `$item.x`, and `$<iterVar>.x` resolve path references.
- `{{path}}` interpolates template strings.
- Expression objects support a small set of conditionals, logic, arithmetic, collection, and string operators.
- Event props use action descriptors like `{ "$action": "setState", "key": "viewMode", "value": "detail" }`.
- Static formatting and variant decisions should usually be precomputed into `data` rather than encoded as complex spec expressions.

See [`specs/README.md`](./specs/README.md) before changing the renderer or authoring new sample specs.

## Development setup

### Prerequisites

- Node.js/npm
- HubSpot CLI authenticated to a developer/test portal
- Wrangler authenticated to Cloudflare
- A configured HubSpot developer app for OAuth-backed worker flows
- Cloudflare D1/KV/Durable Object bindings as defined in `apps/worker/wrangler.toml`

### Run the worker locally

```bash
cd apps/worker
npm install
npm run migrate:local
npm run dev
```

The worker will run at `http://localhost:8787` by default. Point `apps/studio-app/src/app/pages/config.js` at that URL for local backend calls.

Useful worker commands:

```bash
npm run dev              # wrangler dev
npm run deploy           # deploy worker
npm run typecheck        # TypeScript check
npm run knowledge:build  # regenerate bundled knowledge module
npm run migrate:local    # apply schema.sql to local D1
npm run migrate:remote   # apply schema.sql to remote D1
```

`knowledge:build` is run automatically before `dev`, `deploy`, and `typecheck`.

### Run the HubSpot app page

```bash
cd apps/studio-app
hs project dev
```

Deploy/upload to a portal with:

```bash
hs project upload
```

The app page dependencies live under `apps/studio-app/src/app/pages/package.json` and are managed by the HubSpot project tooling.

## Worker secrets and configuration

Secrets are set with `wrangler secret put <NAME>` from `apps/worker/`.

The expected secrets are listed in `wrangler.toml` and include:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY` when using `openai/...` models
- `CLOUDFLARE_API_TOKEN` when using `workers-ai/...` models
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_AI_GATEWAY_ID`
- `CLOUDFLARE_AI_GATEWAY_TOKEN`
- `HUBSPOT_CLIENT_ID`
- `HUBSPOT_CLIENT_SECRET`
- `HUBSPOT_APP_SCOPES`
- `TOKEN_ENCRYPTION_KEY`
- `WORKER_PUBLIC_URL`

The primary chat model is controlled by the `CHAT_MODEL` var in `wrangler.toml`, for example:

```toml
CHAT_MODEL = "anthropic/claude-sonnet-4-6"
```

## Knowledge base

The worker bundles files from `apps/worker/knowledge/` into `src/tools/knowledge.generated.ts`. These files become tool-readable model context:

- `standards/*.md` — design-system and product rules
- `blocks/*.json` — reusable component groups
- `examples/*.json` — complete sample specs

After adding or editing knowledge files, run any worker command or explicitly run:

```bash
cd apps/worker
npm run knowledge:build
```

## Current status

Pre-alpha. The app has the major pieces in place — HubSpot app page, Cloudflare Worker, OAuth/storage, Durable Object-backed streaming/project agent, spec renderer, comments, tweaks, and export surfaces — but the product and spec format are still evolving.

Known rough edges:

- The spec format is v0 and may change.
- There is no standalone test runner or linter configured yet.
- Streaming behavior through HubSpot/proxy environments can be brittle; reload/polling paths are used to recover long-running turns.

## Related projects

- [`hs-uix`](https://github.com/05bmckay/hs-uix) — component library Studio renders and exports against.
- HubSpot UI Extensions SDK — runtime/component environment for the app page and generated cards.
