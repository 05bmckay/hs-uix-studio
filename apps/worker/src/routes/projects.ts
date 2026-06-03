import { Hono } from "hono";
import type { Env } from "../index";
import { requireInstall } from "../lib/verify";

export const projectRoutes = new Hono<{ Bindings: Env }>();

async function ensureLocalInstall(
  env: Env,
  hubId: number,
  userId: number,
): Promise<void> {
  if (!env.WORKER_PUBLIC_URL.includes("localhost")) return;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO installs
       (hub_id, user_id, scopes, access_token_enc, refresh_token_enc, token_iv,
        expires_at, created_at, updated_at, credit_micro_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      hubId,
      userId,
      env.HUBSPOT_APP_SCOPES,
      new Uint8Array(),
      new Uint8Array(),
      new Uint8Array(),
      now + 24 * 60 * 60 * 1000,
      now,
      now,
      3_000_000,
    )
    .run();
}

// GET /projects — list for the caller's portal, newest first.
projectRoutes.get("/", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, description, created_at, updated_at
       FROM projects
      WHERE hub_id = ?
      ORDER BY updated_at DESC`,
  )
    .bind(caller.hubId)
    .all();

  return c.json({ projects: results ?? [] });
});

// POST /projects — create.
interface CreateProjectBody {
  name: string;
  description?: string;
}
projectRoutes.post("/", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const body = ((caller.body as CreateProjectBody | null) ??
    (await c.req.json().catch(() => null))) as CreateProjectBody | null;
  if (!body?.name?.trim()) return c.json({ error: "missing_name" }, 400);

  if (c.env.LOCAL_DEV_AUTH_BYPASS === "true") {
    await ensureLocalInstall(c.env, caller.hubId, caller.userId);
  }

  const id = `p-${crypto.randomUUID()}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO projects (id, hub_id, owner_user_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      caller.hubId,
      caller.userId,
      body.name.trim(),
      body.description?.trim() ?? null,
      now,
      now,
    )
    .run();

  // Seed a default chat thread so the extension has somewhere to send the
  // first message. Users can create additional threads later via /chats.
  const chatId = `c-${crypto.randomUUID()}`;
  await c.env.DB.prepare(
    `INSERT INTO chats (id, project_id, title, created_at, updated_at)
     VALUES (?, ?, 'New chat', ?, ?)`,
  )
    .bind(chatId, id, now, now)
    .run();

  return c.json({
    project: {
      id,
      name: body.name.trim(),
      description: body.description?.trim() ?? null,
      created_at: now,
      updated_at: now,
    },
    defaultChatId: chatId,
  });
});

// GET /projects/:id — single project + spec (if any) + default chat id.
projectRoutes.get("/:id", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const projectId = c.req.param("id");
  const project = await c.env.DB.prepare(
    `SELECT id, name, description, created_at, updated_at
       FROM projects WHERE id = ? AND hub_id = ?`,
  )
    .bind(projectId, caller.hubId)
    .first();
  if (!project) return c.json({ error: "not_found" }, 404);

  const spec = await c.env.DB.prepare(
    `SELECT json FROM specs WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ json: string }>();

  // Most-recently-active chat wins, so reload drops the user back into the
  // thread they were last chatting in — not the oldest thread on the project.
  // updated_at is bumped on every send (see routes/chat.ts), so this tracks
  // "last active" without a separate column.
  const lastChat = await c.env.DB.prepare(
    `SELECT id FROM chats WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(projectId)
    .first<{ id: string }>();

  return c.json({
    project,
    spec: spec ? JSON.parse(spec.json) : null,
    defaultChatId: lastChat?.id ?? null,
  });
});

// PUT /projects/:id/spec — replace the spec JSON for a project. Called
// server-side when a /chat turn produces a new spec; the extension doesn't
// usually write directly, but the route is available for dev/import flows.
projectRoutes.put("/:id/spec", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const projectId = c.req.param("id");
  const owned = await c.env.DB.prepare(
    `SELECT 1 FROM projects WHERE id = ? AND hub_id = ?`,
  )
    .bind(projectId, caller.hubId)
    .first();
  if (!owned) return c.json({ error: "not_found" }, 404);

  const body = (caller.body as unknown) ?? (await c.req.json());
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO specs (project_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    ).bind(projectId, JSON.stringify(body), now),
    c.env.DB.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(
      now,
      projectId,
    ),
  ]);

  return c.json({ ok: true });
});

// PATCH /projects/:id — rename (and optionally re-describe) a project.
// Body: { name?, description? }. Only fields present are updated.
projectRoutes.patch("/:id", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const projectId = c.req.param("id");
  const body = ((caller.body as { name?: string; description?: string } | null) ??
    (await c.req.json().catch(() => null))) as
    | { name?: string; description?: string }
    | null;

  const owned = await c.env.DB.prepare(
    `SELECT 1 FROM projects WHERE id = ? AND hub_id = ?`,
  )
    .bind(projectId, caller.hubId)
    .first();
  if (!owned) return c.json({ error: "not_found" }, 404);

  const updates: string[] = [];
  const binds: unknown[] = [];
  if (typeof body?.name === "string" && body.name.trim()) {
    updates.push("name = ?");
    binds.push(body.name.trim());
  }
  if (typeof body?.description === "string") {
    updates.push("description = ?");
    binds.push(body.description.trim() || null);
  }
  if (updates.length === 0) return c.json({ error: "no_fields" }, 400);

  const now = Date.now();
  updates.push("updated_at = ?");
  binds.push(now);
  binds.push(projectId);

  await c.env.DB.prepare(
    `UPDATE projects SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...binds)
    .run();

  return c.json({ ok: true, updated_at: now });
});

// DELETE /projects/:id — removes the project and everything that cascades
// off it (spec, chats, messages, comments — see ON DELETE CASCADE in the
// schema). Irreversible; UI should confirm before calling.
projectRoutes.delete("/:id", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const projectId = c.req.param("id");
  const owned = await c.env.DB.prepare(
    `SELECT 1 FROM projects WHERE id = ? AND hub_id = ?`,
  )
    .bind(projectId, caller.hubId)
    .first();
  if (!owned) return c.json({ error: "not_found" }, 404);

  await c.env.DB.prepare(`DELETE FROM projects WHERE id = ?`)
    .bind(projectId)
    .run();
  return c.json({ ok: true });
});
