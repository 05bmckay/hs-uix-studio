-- hs-uix-studio D1 schema. Run via:
--   wrangler d1 execute studio --local  --file=./schema.sql
--   wrangler d1 execute studio --remote --file=./schema.sql

-- Per-portal OAuth install. Tokens encrypted at rest (AES-GCM) using
-- TOKEN_ENCRYPTION_KEY. A portal reinstalling the app overwrites the row.
CREATE TABLE IF NOT EXISTS installs (
  hub_id              INTEGER PRIMARY KEY,
  user_id             INTEGER NOT NULL,
  scopes              TEXT    NOT NULL,
  access_token_enc    BLOB    NOT NULL,
  refresh_token_enc   BLOB    NOT NULL,
  token_iv            BLOB    NOT NULL,  -- AES-GCM IV shared by both tokens
  expires_at          INTEGER NOT NULL,   -- epoch ms
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  -- Beta credit budget (1¢ = 1000 µ¢). First 10 installs by created_at get
  -- $30 = 3_000_000 µ¢; beyond that the install is rejected at the OAuth
  -- callback so this defaults to 0. Server enforces by comparing
  -- SUM(usage_events.estimated_cost_micro_cents) for the hub against this.
  credit_micro_cents  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  hub_id        INTEGER NOT NULL REFERENCES installs(hub_id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_hub ON projects(hub_id, updated_at DESC);

-- Specs live 1:1 with projects. Stored as JSON text.
CREATE TABLE IF NOT EXISTS specs (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  json        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Generated design docs (markdown) keyed by project. Cached per spec hash so
-- re-opening the export panel without spec changes is instant. Regenerated
-- when the hash changes or on explicit user request.
CREATE TABLE IF NOT EXISTS design_docs (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  spec_hash   TEXT NOT NULL,
  markdown    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- A chat is a single conversation thread within a project. Projects can have
-- many (history view in the UI).
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('streaming', 'done', 'error')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id       TEXT,
  node_summary  TEXT,
  text          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(project_id, created_at DESC);

-- Token usage ledger for per-portal observability and future rate limiting.
-- One row per completed /chat stream.
CREATE TABLE IF NOT EXISTS usage_events (
  id                    TEXT PRIMARY KEY,
  hub_id                INTEGER NOT NULL,
  chat_id               TEXT    NOT NULL,
  message_id            TEXT    NOT NULL,
  -- Set by writers that don't have a `chats` row to point at (e.g. design-doc
  -- export, chat-title generation). Lets the per-project usage query attribute
  -- those AI calls to a project without joining through `chats`. Older rows
  -- and chat-driven turns leave it NULL and rely on chat_id → chats.id.
  project_id            TEXT,
  model                 TEXT    NOT NULL,
  input_tokens          INTEGER NOT NULL,
  output_tokens         INTEGER NOT NULL,
  -- Legacy field, kept for older rows. Rounded to whole cents — title-upgrade
  -- and other sub-cent calls floor to 0 here. New writers fill `_micro_cents`
  -- (1¢ = 1000 µ¢) and aggregate queries should prefer that column.
  estimated_cost_cents        INTEGER NOT NULL,
  estimated_cost_micro_cents  INTEGER,
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_hub_time ON usage_events(hub_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project_id, created_at DESC);

-- Tool-call audit log. One row per tool dispatch inside a /chat turn so we
-- can see what Studio burned time on (esp. repeated reads, long loops).
CREATE TABLE IF NOT EXISTS tool_calls (
  id             TEXT PRIMARY KEY,
  chat_id        TEXT    NOT NULL,
  message_id     TEXT    NOT NULL,
  round          INTEGER NOT NULL,
  tool_name      TEXT    NOT NULL,
  input_preview  TEXT,
  ok             INTEGER NOT NULL,
  error          TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_chat_time ON tool_calls(chat_id, created_at DESC);

-- Turn timeline: one row per lifecycle event (run_start, round_end, run_done,
-- run_error). Lets us reconstruct what happened without scraping wrangler tail.
CREATE TABLE IF NOT EXISTS stream_events (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  round       INTEGER NOT NULL,
  event       TEXT NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stream_events_message ON stream_events(message_id, created_at ASC);
