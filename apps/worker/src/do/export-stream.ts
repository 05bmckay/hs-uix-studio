// Durable Object per active design-doc export. Mirrors the legacy poll
// protocol (status / append / nextOffset / lastEventAt / done / error) so the
// client's useStream hook can consume it unchanged. Runs a single non-tool
// streaming completion — no tool loop, no round management.
//
// Why this exists: export was previously a synchronous Hono handler, so the
// AI Gateway's ~100s upstream timeout killed long generations outright. DO
// wall time is unbounded, so we can wait out slow models and deliver output
// progressively to the UI.
//
// On success, the final markdown is written to the `design_docs` table keyed
// by project id + spec hash. Clients don't need to POST the result back.

import type { Env } from "../index";
import { createLLMClient, estimateCostCents, estimateCostMicroCents } from "../lib/llm";
import { logUsage } from "../lib/db";

// Same budgets as the original sync export route. Kept here so export-stream
// is self-contained.
const PRIMARY_MAX_OUTPUT_TOKENS = 4000;
const FALLBACK_MAX_OUTPUT_TOKENS = 2200;

type Status = "streaming" | "done" | "error";

interface StartRequest {
  hubId: number;
  projectId: string;
  specHash: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  // Rebuilt with empty transcript for the timeout-retry path.
  fallbackUserPrompt: string;
}

interface Snapshot {
  status: Status;
  content: string;
  error: string | null;
  meta: StartRequest | null;
  lastEventAt: number;
  updatedAt: number | null;
}

export class ExportStream {
  private state: DurableObjectState;
  private env: Env;

  private status: Status = "streaming";
  private content = "";
  private error: string | null = null;
  private meta: StartRequest | null = null;
  private lastEventAt = Date.now();
  private updatedAt: number | null = null;

  private lastPersistAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    state.blockConcurrencyWhile(async () => {
      const snap = await state.storage.get<Snapshot>("snapshot");
      if (!snap) return;
      this.status = snap.status;
      this.content = snap.content;
      this.error = snap.error;
      this.meta = snap.meta;
      this.lastEventAt = snap.lastEventAt ?? Date.now();
      this.updatedAt = snap.updatedAt ?? null;
    });
  }

  private maybePersist(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPersistAt < 250) return;
    this.lastPersistAt = now;
    const snap: Snapshot = {
      status: this.status,
      content: this.content,
      error: this.error,
      meta: this.meta,
      lastEventAt: this.lastEventAt,
      updatedAt: this.updatedAt,
    };
    this.state.storage
      .put("snapshot", snap)
      .catch((err) =>
        console.error("[export-stream] persist snapshot failed:", err),
      );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/start") {
      const body = (await req.json()) as StartRequest;
      this.meta = body;
      this.status = "streaming";
      this.content = "";
      this.error = null;
      this.lastEventAt = Date.now();
      this.updatedAt = null;
      this.maybePersist(true);
      this.state.waitUntil(this.runCompletion());
      return new Response(JSON.stringify({ status: this.status }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (req.method === "GET" && url.pathname === "/poll") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const append = this.content.slice(since);
      return Response.json({
        status: this.status,
        append,
        nextOffset: this.content.length,
        lastEventAt: this.lastEventAt,
        serverNow: Date.now(),
        ...(this.status === "done"
          ? { updatedAt: this.updatedAt }
          : {}),
        ...(this.error ? { error: this.error } : {}),
      });
    }
    return new Response("Not found", { status: 404 });
  }

  private async runCompletion(): Promise<void> {
    const req = this.meta;
    if (!req) return;
    try {
      await this.runCompletionInner(req);
    } finally {
      // Always clear the active-stream row so reload-resume doesn't latch
      // onto a finished DO. Best-effort — log and move on.
      try {
        await this.env.DB.prepare(
          `DELETE FROM design_doc_streams WHERE project_id = ?`,
        )
          .bind(req.projectId)
          .run();
      } catch (err) {
        console.error("[export-stream] clear active stream row failed:", err);
      }
    }
  }

  private async runCompletionInner(req: StartRequest): Promise<void> {
    const client = createLLMClient(this.env, req.model, {
      hubId: req.hubId,
      chatId: `export:${req.projectId}`,
      messageId: `export:design-doc:${Date.now()}`,
    });

    try {
      await this.streamInto(
        client,
        req.model,
        req.systemPrompt,
        req.userPrompt,
        PRIMARY_MAX_OUTPUT_TOKENS,
      );
    } catch (err) {
      if (isGatewayTimeoutError(err)) {
        console.warn("[export-stream] gateway timeout, retrying with compact prompt");
        this.content = "";
        this.lastEventAt = Date.now();
        this.maybePersist(true);
        try {
          await this.streamInto(
            client,
            req.model,
            req.systemPrompt,
            req.fallbackUserPrompt,
            FALLBACK_MAX_OUTPUT_TOKENS,
          );
        } catch (retryErr) {
          this.failWith(retryErr);
          return;
        }
      } else {
        this.failWith(err);
        return;
      }
    }

    const markdown = this.content.trim();
    if (markdown.length === 0) {
      this.failWith(new Error("empty generation"));
      return;
    }

    const now = Date.now();
    try {
      await this.env.DB.prepare(
        `INSERT INTO design_docs (project_id, spec_hash, markdown, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           spec_hash = excluded.spec_hash,
           markdown = excluded.markdown,
           updated_at = excluded.updated_at`,
      )
        .bind(req.projectId, req.specHash, markdown, now)
        .run();
    } catch (err) {
      console.error("[export-stream] DB write failed:", err);
      this.failWith(err);
      return;
    }

    this.content = markdown;
    this.updatedAt = now;
    this.status = "done";
    this.lastEventAt = Date.now();
    this.maybePersist(true);
  }

  private async streamInto(
    client: ReturnType<typeof createLLMClient>,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
  ): Promise<void> {
    // include_usage triggers a final chunk with token totals — without it
    // Anthropic via the gateway never reports usage. Workers AI's compat
    // shim rejects the option, so skip it for that prefix.
    const includeUsage = !model.startsWith("workers-ai/");
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: maxTokens,
      stream: true,
      // No sampling params: Opus 4.7+ removed temperature/top_p/top_k and
      // 400s on them ("`temperature` is deprecated for this model").
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    });

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      this.lastEventAt = Date.now();
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        this.content += content;
        this.maybePersist();
      }
      if (chunk.usage) {
        inputTokens += chunk.usage.prompt_tokens ?? 0;
        outputTokens += chunk.usage.completion_tokens ?? 0;
      }
    }

    const req = this.meta;
    if (req && (inputTokens > 0 || outputTokens > 0)) {
      await logUsage(this.env, {
        id: crypto.randomUUID(),
        hubId: req.hubId,
        chatId: `export:${req.projectId}`,
        messageId: `export:design-doc:${Date.now()}`,
        projectId: req.projectId,
        model,
        inputTokens,
        outputTokens,
        estimatedCostCents: estimateCostCents(model, inputTokens, outputTokens),
        estimatedCostMicroCents: estimateCostMicroCents(model, inputTokens, outputTokens),
      }).catch((err) =>
        console.error("[export-stream] logUsage failed:", err),
      );
    }
  }

  private failWith(err: unknown): void {
    this.status = "error";
    this.error = err instanceof Error ? err.message : String(err);
    this.lastEventAt = Date.now();
    console.error("[export-stream] generation failed:", err);
    this.maybePersist(true);
  }
}

function isGatewayTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /gateway took too long|timed out|timeout/i.test(message);
}
