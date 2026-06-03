import { Hono } from "hono";
import type { Env } from "../index";
import { requireInstall } from "../lib/verify";

export const chatThreadRoutes = new Hono<{ Bindings: Env }>();

// All routes here are scoped to a project. We double-check ownership on every
// call — the schema does it via FK cascade, but an explicit WHERE hub_id = ?
// prevents cross-portal reads if a project_id leaks.

// GET /chats?projectId=... — list threads for a project, newest first.
chatThreadRoutes.get("/", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "missing_projectId" }, 400);
  if (!(await projectOwned(c, projectId, caller.hubId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, created_at, updated_at
       FROM chats WHERE project_id = ? ORDER BY updated_at DESC`,
  )
    .bind(projectId)
    .all();

  return c.json({ chats: results ?? [] });
});

// POST /chats  { projectId, title? }
chatThreadRoutes.post("/", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const body = ((caller.body as { projectId?: string; title?: string } | null) ??
    (await c.req.json())) as { projectId?: string; title?: string };
  if (!body.projectId) return c.json({ error: "missing_projectId" }, 400);
  if (!(await projectOwned(c, body.projectId, caller.hubId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const id = `c-${crypto.randomUUID()}`;
  const now = Date.now();
  const title = (body.title?.trim() || "New chat").slice(0, 120);
  await c.env.DB.prepare(
    `INSERT INTO chats (id, project_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, body.projectId, title, now, now)
    .run();

  return c.json({ chat: { id, title, created_at: now, updated_at: now } });
});

// GET /chats/:id/messages?cursor=<ms>&limit=5
// Newest-first paginated. `cursor` is the created_at of the oldest message
// the client already has; server returns rows older than that. First call
// omits cursor.
chatThreadRoutes.get("/:id/messages", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const chatId = c.req.param("id");
  const owned = await c.env.DB.prepare(
    `SELECT 1 FROM chats c JOIN projects p ON p.id = c.project_id
       WHERE c.id = ? AND p.hub_id = ?`,
  )
    .bind(chatId, caller.hubId)
    .first();
  if (!owned) return c.json({ error: "not_found" }, 404);

  const cursor = Number(c.req.query("cursor") ?? Number.MAX_SAFE_INTEGER);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 5)));

  const { results } = await c.env.DB.prepare(
    `SELECT id, role, content, status, created_at
       FROM messages
      WHERE chat_id = ? AND created_at < ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(chatId, cursor, limit + 1)
    .all<{
      id: string;
      role: string;
      content: string;
      status: string;
      created_at: number;
    }>();

  const rows = results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    messages: page,
    nextCursor: hasMore ? page[page.length - 1].created_at : null,
  });
});

// POST /chats/messages/:id/fail
// Client-called when a 'streaming' message has stalled past the UI's
// hard timeout. Flips the row to 'error' with whatever content the DO
// has accumulated so the message stops looking half-alive after a reload.
// Idempotent: no-ops if the row is already 'done' or 'error'.
chatThreadRoutes.post("/messages/:id/fail", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const messageId = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT m.id, m.status, m.content
       FROM messages m
       JOIN chats ch ON ch.id = m.chat_id
       JOIN projects p ON p.id = ch.project_id
      WHERE m.id = ? AND p.hub_id = ?`,
  )
    .bind(messageId, caller.hubId)
    .first<{ id: string; status: string; content: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "streaming") return c.json({ ok: true, already: row.status });

  // Pull whatever Stream Relay has buffered so the row isn't blank on refresh.
  let finalContent = row.content || "";
  try {
    const stub = c.env.RELAY.get(c.env.RELAY.idFromName(messageId));
    const pollRes = await stub.fetch(
      `https://relay/poll?id=${encodeURIComponent(messageId)}&since=0&eventSince=0`,
    );
    if (pollRes.ok) {
      const data = (await pollRes.json()) as { append?: string; final?: { text?: string } };
      const buffered = data.final?.text ?? data.append;
      if (typeof buffered === "string" && buffered.length > finalContent.length) {
        finalContent = buffered;
      }
    }
  } catch {
    // Relay unreachable — fall through with whatever content we had.
  }

  const notice = "_Studio's stream stalled. This message was interrupted — send a follow-up to continue._";
  const body = finalContent.trim().length > 0 ? `${finalContent.trim()}\n\n${notice}` : notice;
  await c.env.DB.prepare(
    `UPDATE messages SET content = ?, status = 'error' WHERE id = ?`,
  )
    .bind(body, messageId)
    .run();

  return c.json({ ok: true, content: body });
});

async function projectOwned(
  c: { env: Env },
  projectId: string,
  hubId: number,
): Promise<boolean> {
  const row = await c.env.DB.prepare(
    `SELECT 1 FROM projects WHERE id = ? AND hub_id = ?`,
  )
    .bind(projectId, hubId)
    .first();
  return Boolean(row);
}
