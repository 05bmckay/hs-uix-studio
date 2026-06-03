import { Hono } from "hono";
import type { Env } from "../index";
import { requireInstall } from "../lib/verify";

export const commentRoutes = new Hono<{ Bindings: Env }>();

// GET /comments?projectId=... — all comments on a project, newest first.
commentRoutes.get("/", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "missing_projectId" }, 400);
  if (!(await projectOwned(c.env, projectId, caller.hubId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, node_id, node_summary, text, status, created_at
       FROM comments WHERE project_id = ? ORDER BY created_at DESC`,
  )
    .bind(projectId)
    .all();

  return c.json({ comments: results ?? [] });
});

// POST /comments — create. Body: { projectId, nodeId?, nodeSummary?, text }.
interface CreateCommentBody {
  projectId: string;
  nodeId?: string | null;
  nodeSummary?: string | null;
  text: string;
}
commentRoutes.post("/", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const body = ((caller.body as CreateCommentBody | null) ??
    (await c.req.json())) as CreateCommentBody;
  if (!body?.projectId || !body?.text?.trim()) {
    return c.json({ error: "missing_fields" }, 400);
  }
  if (!(await projectOwned(c.env, body.projectId, caller.hubId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const id = `cmt-${crypto.randomUUID()}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO comments
       (id, project_id, node_id, node_summary, text, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(
      id,
      body.projectId,
      body.nodeId ?? null,
      body.nodeSummary ?? null,
      body.text.trim(),
      now,
    )
    .run();

  return c.json({
    comment: {
      id,
      project_id: body.projectId,
      node_id: body.nodeId ?? null,
      node_summary: body.nodeSummary ?? null,
      text: body.text.trim(),
      status: "open",
      created_at: now,
    },
  });
});

// PATCH /comments/:id — partial update. Body: { status? } for now.
commentRoutes.patch("/:id", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const id = c.req.param("id");
  const body = ((caller.body as { status?: "open" | "completed" } | null) ??
    (await c.req.json())) as { status?: "open" | "completed" };
  if (!body?.status || !["open", "completed"].includes(body.status)) {
    return c.json({ error: "missing_or_invalid_status" }, 400);
  }

  const owned = await c.env.DB.prepare(
    `SELECT 1 FROM comments c
       JOIN projects p ON p.id = c.project_id
      WHERE c.id = ? AND p.hub_id = ?`,
  )
    .bind(id, caller.hubId)
    .first();
  if (!owned) return c.json({ error: "not_found" }, 404);

  await c.env.DB.prepare(`UPDATE comments SET status = ? WHERE id = ?`)
    .bind(body.status, id)
    .run();

  return c.json({ ok: true });
});

// DELETE /comments/:id
commentRoutes.delete("/:id", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const id = c.req.param("id");
  // Scope the DELETE by hub_id via EXISTS so a leaked id can't delete across
  // portals. D1 supports subqueries fine.
  const result = await c.env.DB.prepare(
    `DELETE FROM comments
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM projects p
         WHERE p.id = comments.project_id AND p.hub_id = ?
      )`,
  )
    .bind(id, caller.hubId)
    .run();

  if (result.meta?.changes === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

async function projectOwned(
  env: Env,
  projectId: string,
  hubId: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM projects WHERE id = ? AND hub_id = ?`,
  )
    .bind(projectId, hubId)
    .first();
  return Boolean(row);
}
