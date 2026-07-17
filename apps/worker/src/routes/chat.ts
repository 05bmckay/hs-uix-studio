import { Hono } from "hono";
import type { Env } from "../index";
import { requireInstall } from "../lib/verify";
import { getPortalChatConfig } from "../lib/byok";
import { STUDIO_SYSTEM_PROMPT } from "../prompts";
import { logUsage, getHubSpendMicroCents } from "../lib/db";
import { estimateCostCents, estimateCostMicroCents } from "../lib/llm";

const TITLE_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const TITLE_MODEL_PRICING_KEY = `workers-ai/${TITLE_MODEL}`;

export const chatRoutes = new Hono<{ Bindings: Env }>();

interface ChatRequest {
  projectId: string;
  chatId: string;
  userMessage: string;
  // Optional client-supplied conversation history. When absent we rehydrate
  // from D1 so the model sees the full thread. Cap at last N turns to keep
  // prompt size bounded.
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

const MAX_REHYDRATED_TURNS = 20;

// POST /chat
//   Body: { projectId, chatId, userMessage, history? }
//   Returns: { streamId, messageId, userMessageId } immediately.
//
// The extension polls GET /streams/:streamId for the assistant reply as it
// streams. The user message is persisted synchronously; the assistant row
// is created in status='streaming' and flipped to 'done' by the DO.
chatRoutes.post("/", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const body = ((caller.body as ChatRequest | null) ??
    (await c.req.json())) as ChatRequest;
  if (!body.projectId || !body.chatId || !body.userMessage?.trim()) {
    return c.json({ error: "missing_fields" }, 400);
  }

  // Confirm the caller owns the chat thread (and its project).
  const owned = await c.env.DB.prepare(
    `SELECT 1 FROM chats ch
       JOIN projects p ON p.id = ch.project_id
      WHERE ch.id = ? AND p.id = ? AND p.hub_id = ?`,
  )
    .bind(body.chatId, body.projectId, caller.hubId)
    .first();
  if (!owned) return c.json({ error: "not_found" }, 404);

  // Beta credit gate. Hard-block once recorded spend meets/exceeds the
  // install's credit budget so we don't keep burning through Anthropic
  // tokens the user hasn't paid for. Spend is computed from usage_events;
  // a turn that's mid-stream when the cap trips is allowed to finish (we
  // only check at the start of the next turn). Portals that brought their
  // own Anthropic key bypass the gate entirely — the spend is theirs.
  const portalConfig = await getPortalChatConfig(c.env, caller.hubId);
  if (!portalConfig.apiKey) {
    const spend = await getHubSpendMicroCents(c.env, caller.hubId);
    if (spend >= caller.install.creditMicroCents) {
      return c.json(
        {
          error: "credit_exhausted",
          message:
            "Your Studio beta credit has been spent. Add your own Anthropic API key in Settings to keep going, or reach out to me@cartermckay.com to top up.",
          creditMicroCents: caller.install.creditMicroCents,
          spendMicroCents: spend,
        },
        402,
      );
    }
  }

  const now = Date.now();
  const userMessageId = `m-${crypto.randomUUID()}`;
  const assistantMessageId = `m-${crypto.randomUUID()}`;
  const trimmed = body.userMessage.trim();

  // If this is the first user turn in the chat and the title is still the
  // default, derive a title from the message. Single-line, ~60 char cap.
  const firstUserCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND role = 'user'`,
  )
    .bind(body.chatId)
    .first<{ n: number }>();
  const isFirstUserTurn = (firstUserCount?.n ?? 0) === 0;

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO messages (id, chat_id, role, content, status, created_at)
       VALUES (?, ?, 'user', ?, 'done', ?)`,
    ).bind(userMessageId, body.chatId, trimmed, now),
    c.env.DB.prepare(
      `INSERT INTO messages (id, chat_id, role, content, status, created_at)
       VALUES (?, ?, 'assistant', '', 'streaming', ?)`,
    ).bind(assistantMessageId, body.chatId, now + 1),
  ];
  // Provisional title from truncation goes in the batch so the chat row is
  // immediately usable. If this is the first user turn, kick off the Workers
  // AI title-generation job in the background — it updates the row with a
  // smarter title once the small model returns. Never blocks the /chat
  // response.
  if (isFirstUserTurn) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE chats SET updated_at = ?, title = ?
          WHERE id = ? AND title = 'New chat'`,
      ).bind(now, truncateChatTitle(trimmed), body.chatId),
    );
  } else {
    stmts.push(
      c.env.DB.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).bind(
        now,
        body.chatId,
      ),
    );
  }
  await c.env.DB.batch(stmts);

  if (isFirstUserTurn) {
    c.executionCtx.waitUntil(
      upgradeChatTitleInBackground(
        c.env,
        body.chatId,
        trimmed,
        caller.hubId,
        body.projectId,
      ),
    );
  }

  // Assemble the conversation the model sees. Client-supplied history wins
  // for the prototype path; otherwise rehydrate from D1.
  let messages = body.history ?? [];
  if (!body.history) {
    const { results } = await c.env.DB.prepare(
      `SELECT role, content FROM messages
        WHERE chat_id = ? AND role IN ('user', 'assistant') AND id != ?
        ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(body.chatId, assistantMessageId, MAX_REHYDRATED_TURNS)
      .all<{ role: "user" | "assistant"; content: string }>();
    messages = (results ?? []).reverse();
  }
  // Ensure the current user turn is the last entry even if history lacks it.
  if (
    messages.length === 0 ||
    messages[messages.length - 1].content !== trimmed
  ) {
    messages = [...messages, { role: "user", content: trimmed }];
  }

  // Inject the project's current spec so Studio can make targeted edits
  // without asking the user to paste it back. Kept SEPARATE from the static
  // prompt so the DO can put it after a prompt-cache breakpoint: the static
  // prompt + tools cache across turns, only the spec resends in full.
  const currentSpecRow = await c.env.DB.prepare(
    `SELECT json FROM specs WHERE project_id = ?`,
  )
    .bind(body.projectId)
    .first<{ json: string }>();

  const systemSpec = currentSpecRow?.json
    ? "---\n\n## Current spec for this project\n\n" +
      "The JSON below is the authoritative current spec. Treat it as the" +
      " baseline for every edit — use patch_spec to revise it in place." +
      " Do NOT call any 'fetch spec' tool; the spec you see here is the" +
      " latest state.\n\n" +
      "```json\n" +
      currentSpecRow.json +
      "\n```"
    : null;

  // Reuse the assistant message id as the streamId so the client can
  // reconnect to an in-flight stream after a page reload using only the
  // data in the messages table (which has status='streaming' rows).
  const streamId = assistantMessageId;
  const relayId = c.env.RELAY.idFromName(streamId);
  const relay = c.env.RELAY.get(relayId);

  await relay.fetch("https://relay/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      streamId,
      payload: {
        kind: "chat",
        legacy: {
          hubId: caller.hubId,
          projectId: body.projectId,
          chatId: body.chatId,
          messageId: assistantMessageId,
          model: portalConfig.chatModel ?? c.env.CHAT_MODEL,
          systemStatic: STUDIO_SYSTEM_PROMPT,
          systemSpec,
          messages,
        },
      },
    }),
  });

  return c.json({ streamId, messageId: assistantMessageId, userMessageId });
});

// Provisional chat title — a safe truncation of the user's first message.
// Shows up instantly in the history list; the background AI job replaces it
// with something short and topical.
function truncateChatTitle(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 60) return collapsed;
  return collapsed.slice(0, 57).trim() + "...";
}

// Small, local Workers AI model (~1B params) generates a clean 2-5 word
// title for the chat. Runs via executionCtx.waitUntil so the /chat response
// isn't delayed. On any failure (timeout, model error, bad output) we leave
// the provisional truncated title in place.
async function upgradeChatTitleInBackground(
  env: Env,
  chatId: string,
  firstMessage: string,
  hubId: number,
  projectId: string,
): Promise<void> {
  try {
    const result = (await env.AI.run(TITLE_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You name chat threads. Given the user's first message, output a short 2-5 word title in sentence case that captures the topic. No quotes, no punctuation at the end, no prefixes like 'Chat about'. Output only the title.",
        },
        { role: "user", content: firstMessage.slice(0, 500) },
      ],
      max_tokens: 24,
    })) as {
      response?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const inputTokens = result?.usage?.prompt_tokens ?? 0;
    const outputTokens = result?.usage?.completion_tokens ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
      await logUsage(env, {
        id: crypto.randomUUID(),
        hubId,
        chatId,
        messageId: `title:${chatId}`,
        projectId,
        model: TITLE_MODEL_PRICING_KEY,
        inputTokens,
        outputTokens,
        estimatedCostCents: estimateCostCents(
          TITLE_MODEL_PRICING_KEY,
          inputTokens,
          outputTokens,
        ),
        estimatedCostMicroCents: estimateCostMicroCents(
          TITLE_MODEL_PRICING_KEY,
          inputTokens,
          outputTokens,
        ),
      }).catch((err) =>
        console.error("[chat] title logUsage failed:", err),
      );
    }

    const title = sanitizeAiTitle(result?.response);
    if (!title) return;

    // Only replace if the row still has the provisional truncated title —
    // don't clobber a user-set rename that might land between now and here.
    await env.DB.prepare(
      `UPDATE chats SET title = ?, updated_at = ?
        WHERE id = ? AND title != 'New chat' AND title = ?`,
    )
      .bind(title, Date.now(), chatId, truncateChatTitle(firstMessage))
      .run();
  } catch (err) {
    console.error("[chat] AI title upgrade failed:", err);
  }
}

function sanitizeAiTitle(raw: string | undefined): string | null {
  if (!raw) return null;
  let title = raw.trim();
  // Strip surrounding quotes the model likes to add.
  title = title.replace(/^["'`]|["'`]$/g, "").trim();
  // Collapse whitespace and trim trailing punctuation.
  title = title.replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "").trim();
  if (!title) return null;
  if (title.length > 60) title = title.slice(0, 57).trim() + "...";
  return title;
}
