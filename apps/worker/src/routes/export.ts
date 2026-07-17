// Design-doc export. Model-generated markdown aimed at eng + product design
// teams who need to actually build the card. Grounded in the spec, enriched
// with chat context for intent.
//
// Two endpoints:
//   GET  /export/:projectId/design-doc — peek at cached state without
//        generating. Returns markdown (nullable), spec hash, staleness flag,
//        spec.updated_at.
//   POST /export/:projectId/design-doc[?regenerate=1] — generate. Cache hit
//        returns { markdown, updated_at, cached: true } with 200. Otherwise
//        starts an ExportStream DO and returns { streamId, cached: false }
//        with 202; the client polls /streams/:id for progressive output, and
//        the DO writes the final markdown to design_docs on completion.

import { Hono } from "hono";
import type { Env } from "../index";
import { requireInstall } from "../lib/verify";
import { getPortalChatConfig } from "../lib/byok";
import { DESIGN_DOC_PROMPT } from "../prompts";

export const exportRoutes = new Hono<{ Bindings: Env }>();

const PRIMARY_MAX_CHAT_CONTEXT_MESSAGES = 40;
const PRIMARY_MAX_MESSAGE_CHARS = 2000;
const ENSURE_DESIGN_DOCS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS design_docs (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    spec_hash   TEXT NOT NULL,
    markdown    TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  )
`;

// Tracks the in-flight export stream (if any) per project so the client can
// reattach after a reload. The DO clears its row on done/error; stale rows
// older than STREAM_RESUME_TTL_MS are ignored on read.
const ENSURE_DESIGN_DOC_STREAMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS design_doc_streams (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    stream_id   TEXT NOT NULL,
    started_at  INTEGER NOT NULL
  )
`;

const STREAM_RESUME_TTL_MS = 15 * 60 * 1000;

interface Row {
  content: string;
  created_at: number;
}

// GET /export/:projectId/design-doc
//   Returns: {
//     markdown: string | null,
//     updated_at: number | null,   // when the cached markdown was generated
//     spec_updated_at: number | null,
//     stale: boolean,              // true if spec changed since doc was made
//     has_spec: boolean,
//   }
exportRoutes.get("/:projectId/design-doc", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  await ensureDesignDocsTable(c.env);

  const projectId = c.req.param("projectId");
  const owned = await c.env.DB.prepare(
    `SELECT 1 FROM projects WHERE id = ? AND hub_id = ?`,
  )
    .bind(projectId, caller.hubId)
    .first();
  if (!owned) return c.json({ error: "not_found" }, 404);

  const specRow = await c.env.DB.prepare(
    `SELECT json, updated_at FROM specs WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ json: string; updated_at: number }>();

  const doc = await c.env.DB.prepare(
    `SELECT markdown, updated_at, spec_hash FROM design_docs WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ markdown: string; updated_at: number; spec_hash: string }>();

  let stale = false;
  if (specRow?.json && doc?.spec_hash) {
    const currentHash = await sha256Hex(specRow.json);
    stale = currentHash !== doc.spec_hash;
  }

  const activeStream = await c.env.DB.prepare(
    `SELECT stream_id, started_at FROM design_doc_streams WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ stream_id: string; started_at: number }>();
  const streamFresh =
    !!activeStream && Date.now() - activeStream.started_at < STREAM_RESUME_TTL_MS;

  return c.json({
    markdown: doc?.markdown ?? null,
    updated_at: doc?.updated_at ?? null,
    spec_updated_at: specRow?.updated_at ?? null,
    stale,
    has_spec: !!specRow?.json,
    active_stream_id: streamFresh ? activeStream!.stream_id : null,
    active_stream_started_at: streamFresh ? activeStream!.started_at : null,
  });
});

// POST /export/:projectId/design-doc[?regenerate=1]
//   Returns: { markdown, updated_at, cached }
exportRoutes.post("/:projectId/design-doc", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  await ensureDesignDocsTable(c.env);

  const projectId = c.req.param("projectId");
  const regenerate = c.req.query("regenerate") === "1";

  const project = await c.env.DB.prepare(
    `SELECT id, name FROM projects WHERE id = ? AND hub_id = ?`,
  )
    .bind(projectId, caller.hubId)
    .first<{ id: string; name: string }>();
  if (!project) return c.json({ error: "not_found" }, 404);

  const specRow = await c.env.DB.prepare(
    `SELECT json FROM specs WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ json: string }>();
  if (!specRow?.json) return c.json({ error: "no_spec" }, 400);

  const specHash = await sha256Hex(specRow.json);

  if (!regenerate) {
    const cached = await c.env.DB.prepare(
      `SELECT markdown, updated_at, spec_hash FROM design_docs WHERE project_id = ?`,
    )
      .bind(projectId)
      .first<{ markdown: string; updated_at: number; spec_hash: string }>();
    if (cached && cached.spec_hash === specHash) {
      return c.json({
        markdown: cached.markdown,
        updated_at: cached.updated_at,
        cached: true,
      });
    }
  }

  // Gather recent user requests across all threads in the project. We only
  // pull user messages — assistant replies invite the model to "continue the
  // conversation" instead of writing a doc, and the user's own asks are what
  // we actually need to capture intent in the doc.
  const { results: msgResults } = await c.env.DB.prepare(
    `SELECT m.content, m.created_at
       FROM messages m
       JOIN chats ch ON ch.id = m.chat_id
      WHERE ch.project_id = ?
        AND m.role = 'user'
        AND m.content != ''
       ORDER BY m.created_at DESC
       LIMIT ?`,
  )
    .bind(projectId, PRIMARY_MAX_CHAT_CONTEXT_MESSAGES)
    .all<Row>();

  const transcript = (msgResults ?? [])
    .reverse()
    .map((r) => {
      const body = r.content.length > PRIMARY_MAX_MESSAGE_CHARS
        ? r.content.slice(0, PRIMARY_MAX_MESSAGE_CHARS) + "…"
        : r.content;
      return `- ${body.replace(/\n+/g, " ")}`;
    })
    .join("\n");

  const compactSpecJson = compactJson(specRow.json);
  const userPrompt = buildDesignDocPrompt(project.name, compactSpecJson, transcript);
  const fallbackUserPrompt = buildDesignDocPrompt(project.name, compactSpecJson, "");

  // Kick off a DO-backed streaming job and return the streamId immediately.
  // The UI polls /streams/:id the same way it polls chat streams; the DO
  // writes the final markdown to design_docs on completion.
  const streamId = `export:${projectId}:${Date.now()}`;
  const portalConfig = await getPortalChatConfig(c.env, caller.hubId);
  const doId = c.env.EXPORT_STREAM.idFromName(streamId);
  const stub = c.env.EXPORT_STREAM.get(doId);
  const startRes = await stub.fetch("https://do/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hubId: caller.hubId,
      projectId,
      specHash,
      model: portalConfig.chatModel ?? c.env.CHAT_MODEL,
      systemPrompt: DESIGN_DOC_PROMPT,
      userPrompt,
      fallbackUserPrompt,
    }),
  });
  if (!startRes.ok) {
    const text = await startRes.text();
    console.error("[export/design-doc] DO start failed:", startRes.status, text);
    return c.json({ error: "generation_failed", message: text }, 502);
  }

  // Record the in-flight stream so a mid-generation reload can reattach.
  // The DO clears this row on completion/error.
  try {
    await c.env.DB.prepare(
      `INSERT INTO design_doc_streams (project_id, stream_id, started_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         stream_id = excluded.stream_id,
         started_at = excluded.started_at`,
    )
      .bind(projectId, streamId, Date.now())
      .run();
  } catch (err) {
    console.error("[export/design-doc] track active stream failed:", err);
  }

  return c.json({ streamId, cached: false }, 202);
});

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureDesignDocsTable(env: Env): Promise<void> {
  await env.DB.prepare(ENSURE_DESIGN_DOCS_TABLE_SQL).run();
  await env.DB.prepare(ENSURE_DESIGN_DOC_STREAMS_TABLE_SQL).run();
}

function buildDesignDocPrompt(
  projectName: string,
  specJson: string,
  transcript: string,
): string {
  return [
    `Project: ${projectName}`,
    "",
    "## User requests (chronological)",
    "",
    "These are the prototyper's own messages — what they asked for, in their own words. Use them to understand intent and make sure the design doc reflects what the user was trying to build. Do not quote them verbatim.",
    "",
    transcript || "_(no user requests captured yet)_",
    "",
    "## Spec JSON",
    "",
    "```json",
    specJson,
    "```",
    "",
    "Now write the design doc per the system prompt's section order. Begin your output with the H1 title.",
  ].join("\n");
}

function compactJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
}
