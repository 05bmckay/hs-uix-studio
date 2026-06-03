import { Hono } from "hono";
import type { Env } from "../index";
import { requireInstall } from "../lib/verify";
import { fetchAllUsers, type UserLookupDebug } from "../lib/hubspot";
import { getHubSpendMicroCents } from "../lib/db";

// GET /usage/summary?window=7d|30d|all
//
// Returns the single payload powering the Studio Settings & Usage page.
// All aggregates are scoped to caller.hubId. The `window` param only
// affects *time-bound* metrics (tokens, cost, daily chart, per-project
// & per-user aggregates, latency). Portal-wide counts (total projects,
// total chats) ignore it — they're lifetime.
//
// Percent-delta on projectUsage compares the selected window against
// the immediately-preceding window of equal length; omitted for "all".
//
// We deliberately do NOT format numbers server-side (e.g. "872K",
// "$1.38"). The page formats so future consumers (exports, emails) can
// make their own choices.

export const usageRoutes = new Hono<{ Bindings: Env }>();

type Window = "7d" | "30d" | "all";

const DAY_MS = 24 * 60 * 60 * 1000;

function windowBounds(window: Window, now: number) {
  if (window === "7d") return { start: now - 7 * DAY_MS, days: 7 };
  if (window === "30d") return { start: now - 30 * DAY_MS, days: 30 };
  return { start: 0, days: null };
}

interface UsageRow {
  input_tokens: number;
  output_tokens: number;
  cost_micro_cents: number;
}

interface DailyRow {
  day: string;
  input_tokens: number;
  output_tokens: number;
}

interface ProjectRow {
  id: string;
  name: string;
  owner_user_id: number;
  updated_at: number;
  chats: number;
  tokens: number;
  cost_micro_cents: number;
  last_active: number | null;
}

interface UserRow {
  owner_user_id: number;
  projects: number;
  tokens: number;
  cost_micro_cents: number;
  last_active: number | null;
}

interface LatencyRow {
  message_id: string;
  duration_ms: number;
}

usageRoutes.get("/summary", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const windowParam = (c.req.query("window") ?? "30d") as Window;
  const window: Window =
    windowParam === "7d" || windowParam === "all" ? windowParam : "30d";

  const now = Date.now();
  const { start, days } = windowBounds(window, now);
  // Prior-period comparison for project delta. "all" has no meaningful
  // comparison — we skip deltas in that case.
  const priorStart = days != null ? start - days * DAY_MS : null;
  const thirtyDaysAgo = now - 30 * DAY_MS;
  const sevenDaysAgo = now - 7 * DAY_MS;
  const startOfMonth = (() => {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  })();

  const hubId = caller.hubId;

  // Install row for portal tile.
  const install = await c.env.DB.prepare(
    `SELECT user_id, scopes, expires_at, created_at
       FROM installs WHERE hub_id = ?`,
  )
    .bind(hubId)
    .first<{
      user_id: number;
      scopes: string;
      expires_at: number;
      created_at: number;
    }>();

  // Overview counts — lifetime and scoped sub-counts.
  const projectCounts = await c.env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS created_this_month
     FROM projects WHERE hub_id = ?`,
  )
    .bind(startOfMonth, hubId)
    .first<{ total: number; created_this_month: number }>();

  const chatCounts = await c.env.DB.prepare(
    `SELECT
       COUNT(c.id) AS total,
       SUM(CASE WHEN c.updated_at >= ? THEN 1 ELSE 0 END) AS recent_7d
     FROM chats c
     JOIN projects p ON p.id = c.project_id
     WHERE p.hub_id = ?`,
  )
    .bind(sevenDaysAgo, hubId)
    .first<{ total: number; recent_7d: number }>();

  // 30d token rollup for overview (regardless of the selected window —
  // the Overview tab always shows a fixed 30d slice per spec).
  const overview30dRow = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(COALESCE(estimated_cost_micro_cents, estimated_cost_cents * 1000)), 0) AS cost_micro_cents
     FROM usage_events
     WHERE hub_id = ? AND created_at >= ?`,
  )
    .bind(hubId, thirtyDaysAgo)
    .first<UsageRow>();

  // Usage tab totals for the selected window.
  const windowTotalsRow = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(COALESCE(estimated_cost_micro_cents, estimated_cost_cents * 1000)), 0) AS cost_micro_cents
     FROM usage_events
     WHERE hub_id = ? AND created_at >= ?`,
  )
    .bind(hubId, start)
    .first<UsageRow>();

  // Daily token volume for the chart. Returned as two series (Input,
  // Output) per day so LineChart can group by `Series` and color-code.
  // For "all" we cap the lookback at 90 days — D1 can scan the full
  // table but a 1-year chart on a category axis gets illegible fast.
  const dailyStart = window === "all" ? now - 90 * DAY_MS : start;
  const { results: dailyResults } = await c.env.DB.prepare(
    `SELECT
       date(created_at / 1000, 'unixepoch') AS day,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM usage_events
     WHERE hub_id = ? AND created_at >= ?
     GROUP BY day
     ORDER BY day ASC`,
  )
    .bind(hubId, dailyStart)
    .all<DailyRow>();

  // Project aggregates over the window. LEFT JOIN so projects with no
  // in-window usage still appear (tokens=0).
  const { results: projectResults } = await c.env.DB.prepare(
    `SELECT
       p.id AS id,
       p.name AS name,
       p.owner_user_id AS owner_user_id,
       p.updated_at AS updated_at,
       COUNT(DISTINCT c.id) AS chats,
       COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens,
       COALESCE(SUM(COALESCE(u.estimated_cost_micro_cents, u.estimated_cost_cents * 1000)), 0) AS cost_micro_cents,
       MAX(u.created_at) AS last_active
     FROM projects p
     LEFT JOIN chats c ON c.project_id = p.id
     LEFT JOIN usage_events u
       ON (u.chat_id = c.id OR u.project_id = p.id)
      AND u.created_at >= ?
     WHERE p.hub_id = ?
     GROUP BY p.id
     ORDER BY tokens DESC, p.updated_at DESC`,
  )
    .bind(start, hubId)
    .all<ProjectRow>();

  // Prior-window token totals per project for delta %.
  const priorByProjectId = new Map<string, number>();
  if (priorStart != null) {
    const { results: priorResults } = await c.env.DB.prepare(
      `SELECT p.id AS id,
              COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens
         FROM projects p
         LEFT JOIN chats c ON c.project_id = p.id
         LEFT JOIN usage_events u
           ON (u.chat_id = c.id OR u.project_id = p.id)
          AND u.created_at >= ? AND u.created_at < ?
         WHERE p.hub_id = ?
         GROUP BY p.id`,
    )
      .bind(priorStart, start, hubId)
      .all<{ id: string; tokens: number }>();
    for (const r of priorResults ?? []) priorByProjectId.set(r.id, r.tokens);
  }

  // Per-user aggregates for the Team tab. Joins users *by owner_user_id
  // on the project* — so a chat's tokens are attributed to the project
  // owner, not necessarily the teammate who sent the message. That's a
  // known simplification until messages carry their own user_id.
  const { results: userResults } = await c.env.DB.prepare(
    `SELECT
       p.owner_user_id AS owner_user_id,
       COUNT(DISTINCT p.id) AS projects,
       COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens,
       COALESCE(SUM(COALESCE(u.estimated_cost_micro_cents, u.estimated_cost_cents * 1000)), 0) AS cost_micro_cents,
       MAX(u.created_at) AS last_active
     FROM projects p
     LEFT JOIN chats c ON c.project_id = p.id
     LEFT JOIN usage_events u
       ON (u.chat_id = c.id OR u.project_id = p.id)
      AND u.created_at >= ?
     WHERE p.hub_id = ?
     GROUP BY p.owner_user_id
     ORDER BY tokens DESC`,
  )
    .bind(start, hubId)
    .all<UserRow>();

  // Last chat (any time) — Overview tab "Last chat N minutes ago · Project".
  const lastChat = await c.env.DB.prepare(
    `SELECT c.updated_at AS updated_at, p.name AS project_name
       FROM chats c
       JOIN projects p ON p.id = c.project_id
      WHERE p.hub_id = ?
      ORDER BY c.updated_at DESC
      LIMIT 1`,
  )
    .bind(hubId)
    .first<{ updated_at: number; project_name: string }>();

  // Per-turn latency from stream_events: run_start → run_done pairs per
  // message_id within the window. Compute avg + p95 in JS — D1 has no
  // percentile function.
  const { results: latencyResults } = await c.env.DB.prepare(
    `SELECT se.message_id AS message_id,
            MAX(CASE WHEN se.event = 'run_done'  THEN se.created_at END) -
            MAX(CASE WHEN se.event = 'run_start' THEN se.created_at END) AS duration_ms
       FROM stream_events se
       JOIN chats c ON c.id = se.chat_id
       JOIN projects p ON p.id = c.project_id
      WHERE p.hub_id = ? AND se.created_at >= ?
      GROUP BY se.message_id
      HAVING duration_ms IS NOT NULL AND duration_ms > 0`,
  )
    .bind(hubId, start)
    .all<LatencyRow>();

  const durations = (latencyResults ?? [])
    .map((r) => r.duration_ms)
    .filter((n): n is number => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);
  const avgMs =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;
  const p95Ms =
    durations.length > 0
      ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
      : null;

  // Connection health: install exists AND a refresh token is usable.
  // `expires_at` is the access-token expiry; we always refresh before
  // outbound calls, so "connected" really means "install row present".
  const connected = Boolean(install);
  const connectionStatusLabel = connected
    ? "Connection active"
    : "Not installed";
  const connectionStatusVariant = connected ? "success" : "danger";

  // Resolve user IDs to names/emails via HubSpot CRM users (requires
  // `crm.objects.users.read` scope). We list the whole portal directory
  // once — keyed by `hs_internal_user_id`, which matches the OAuth user_id
  // stored on installs/projects. Without the scope this returns empty and
  // rows fall back to userName/userEmail = null → client renders `User #<id>`.
  const userLookupDebug: UserLookupDebug = { scopes: "", pages: 0, attempts: [] };
  const userDirectory = await fetchAllUsers(caller.install, userLookupDebug);
  const lifetimeSpendMicroCents = await getHubSpendMicroCents(c.env, hubId);

  const projectUsage = (projectResults ?? []).map((r) => {
    const prior = priorByProjectId.get(r.id);
    let delta: number | null = null;
    if (priorStart != null) {
      if (prior == null || prior === 0) {
        // "New" signal when there was no prior-window usage but there is now.
        delta = r.tokens > 0 ? null : null;
      } else {
        delta = Math.round(((r.tokens - prior) / prior) * 100);
      }
    }
    const isNew = priorStart != null && (prior == null || prior === 0) && r.tokens > 0;
    const owner = userDirectory.get(r.owner_user_id);
    return {
      id: r.id,
      name: r.name,
      ownerUserId: r.owner_user_id,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      chats: r.chats ?? 0,
      tokens: r.tokens ?? 0,
      costMicroCents: r.cost_micro_cents ?? 0,
      deltaPercent: isNew ? null : delta,
      isNew,
      lastActive: r.last_active,
      updatedAt: r.updated_at,
    };
  });

  const team = (userResults ?? []).map((r) => {
    const u = userDirectory.get(r.owner_user_id);
    return {
      userId: r.owner_user_id,
      userName: u?.name ?? null,
      userEmail: u?.email ?? null,
      projects: r.projects ?? 0,
      tokens: r.tokens ?? 0,
      costMicroCents: r.cost_micro_cents ?? 0,
      lastActive: r.last_active,
    };
  });

  const totalTeamTokens = team.reduce((a, b) => a + b.tokens, 0);

  return c.json({
    _debug: { userLookup: userLookupDebug },
    window,
    now,
    windowStart: start,
    portal: (() => {
      const authUserId = install?.user_id ?? caller.userId;
      const authUser = userDirectory.get(authUserId);
      return {
        hubId,
        authUserId,
        authUserName: authUser?.name ?? null,
        authUserEmail: authUser?.email ?? null,
        installedAt: install?.created_at ?? null,
        expiresAt: install?.expires_at ?? null,
        connected,
        connectionStatusLabel,
        connectionStatusVariant,
        // Credit is a lifetime budget, so we compare against lifetime
        // spend (not the windowed figure rendered elsewhere on the page).
        creditMicroCents: caller.install.creditMicroCents,
        spendMicroCents: lifetimeSpendMicroCents,
      };
    })(),
    overview: {
      projects: projectCounts?.total ?? 0,
      projectsCreatedThisMonth: projectCounts?.created_this_month ?? 0,
      chats: chatCounts?.total ?? 0,
      chatsLast7d: chatCounts?.recent_7d ?? 0,
      tokens30d: {
        input: overview30dRow?.input_tokens ?? 0,
        output: overview30dRow?.output_tokens ?? 0,
        total:
          (overview30dRow?.input_tokens ?? 0) +
          (overview30dRow?.output_tokens ?? 0),
      },
      costMicroCents30d: overview30dRow?.cost_micro_cents ?? 0,
      lastChat: lastChat
        ? {
            updatedAt: lastChat.updated_at,
            projectName: lastChat.project_name,
          }
        : null,
    },
    usage: {
      inputTokens: windowTotalsRow?.input_tokens ?? 0,
      outputTokens: windowTotalsRow?.output_tokens ?? 0,
      costMicroCents: windowTotalsRow?.cost_micro_cents ?? 0,
      avgLatencyMs: avgMs,
      p95LatencyMs: p95Ms,
      sampleSize: durations.length,
      daily: (dailyResults ?? []).map((r) => ({
        day: r.day,
        input: r.input_tokens ?? 0,
        output: r.output_tokens ?? 0,
      })),
      projectUsage,
    },
    team: {
      activeTeammates: team.filter((t) => t.tokens > 0).length,
      totalTeammates: team.length,
      totalTokens: totalTeamTokens,
      rows: team,
    },
  });
});
