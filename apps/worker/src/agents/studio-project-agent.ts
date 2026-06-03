// Durable Object per active chat-completions stream. Holds the growing response
// in memory so concurrent polls from the extension see a consistent view
// without hammering D1. On completion, flushes the final content to the
// `messages` row and logs a `usage_events` entry.
//
// Implements the tool-use loop server-side against the Cloudflare AI Gateway
// Unified (OpenAI-compat) endpoint:
//   1. Call chat.completions.create with tools[] attached, streaming.
//   2. Stream delta.content into this.content (what the client sees).
//   3. Accumulate delta.tool_calls[] by index (tool_call args stream as
//      partial JSON strings).
//   4. On finish_reason === "tool_calls", dispatch each tool, append the
//      assistant message (with tool_calls) and one tool-role message per
//      result, then loop. Until finish_reason === "stop" or the cap is hit.
//
// Tool calls themselves are NOT surfaced in the text stream — the user sees
// only Studio's prose and final spec; the tool dance is implementation detail.
//
// In-memory turn state (`content`, `patchLog`, etc.) is *not* mirrored to DO
// storage — the Stream Relay DO is what persists user-visible chunks. To
// survive a CPU eviction mid-turn, the conversation runs inside a `runFiber()`
// (Cloudflare Agents SDK durable execution): a SQLite-backed fiber row is
// created at the start, snapshots are stashed at each round boundary, and
// `onFiberRecovered` runs on the next DO activation if the run was
// interrupted — marking the in-flight D1 message as errored with whatever
// partial content was checkpointed, so the UI exits its `streaming` state
// instead of hanging forever.

import { Agent } from "agents";
import type { FiberContext, FiberRecoveryContext } from "agents";
import type { Env } from "../index";
import type OpenAI from "openai";
import { createLLMClient, estimateCostCents, estimateCostMicroCents } from "../lib/llm";
import { logUsage } from "../lib/db";
import { TOOL_DEFINITIONS, dispatchTool } from "../tools";
import { validateSpec } from "../tools/validate";
import { repairSpec } from "../tools/repair";
import { applyPatch, type PatchOp } from "../lib/patch";
import { createParser } from "../lib/partial-spec";

// Keep this intentionally low: each tool round resends the full system prompt,
// tool schema, conversation, prior tool calls, and tool results. A broken loop
// can otherwise burn hundreds of thousands of input tokens on a simple card.
const MAX_TOOL_ROUNDS = 12;

// Tools whose result is pure w.r.t. input — calling them twice with the
// same args in one turn is always wasted work. We short-circuit repeats to
// the cached result so the model sees consistent data AND can't burn rounds
// re-fetching what it already has.
const CACHEABLE_TOOLS = new Set([
  "read_standards",
  "read_block",
  "read_example",
  "search_knowledge",
  "list_knowledge",
]);

// Fallback when the model ends a turn without any user-visible text.
// Usually happens when Studio hits the tool-round cap or returns only
// tool_calls. Without this the UI shows an empty assistant bubble.
const EMPTY_CONTENT_FALLBACK =
  "(Studio didn't produce a written reply — try rephrasing or sending a follow-up.)";

// Message prepended when we exit the tool loop because we hit MAX_TOOL_ROUNDS.
const TOOL_CAP_NOTICE =
  "_I hit the tool-use cap for this turn. Send me a follow-up if you'd like me to keep going._";

function cacheKeyFor(toolName: string, input: unknown): string {
  try {
    return `${toolName}::${JSON.stringify(input ?? {})}`;
  } catch {
    return `${toolName}::?`;
  }
}

function phaseLabelFor(toolName: string, input: Record<string, unknown>): string {
  const s = (v: unknown, max = 40): string => {
    if (v == null) return "";
    const str = typeof v === "string" ? v : JSON.stringify(v);
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  };
  switch (toolName) {
    case "search_knowledge":
      return input.query ? `Searching: "${s(input.query)}"` : "Searching the knowledge base";
    case "list_knowledge":
      return "Scanning the knowledge index";
    case "read_standards":
      return input.file ? `Reading ${s(input.file, 30)}` : "Reading design standards";
    case "read_block":
      return input.name ? `Looking up block "${s(input.name, 30)}"` : "Looking up a block";
    case "read_example":
      return input.name ? `Studying example "${s(input.name, 30)}"` : "Studying an example";
    case "patch_spec":
      return "Editing the spec";
    case "ask_questions": {
      const qs = Array.isArray(input.questions) ? input.questions.length : 0;
      return qs ? `Preparing ${qs} question${qs === 1 ? "" : "s"}` : "Preparing questions";
    }
    default:
      return `Running ${toolName}`;
  }
}

interface StartRequest {
  hubId: number;
  projectId: string;
  chatId: string;
  messageId: string;
  model: string;
  // Split so the caller can separate static prompt (same across turns)
  // from per-project spec (changes on mutations). In this OpenAI-compat
  // path we concatenate them into a single system message — we don't have
  // Anthropic's per-block cache_control, so the split is only structural.
  systemStatic: string;
  systemSpec: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

type Status = "streaming" | "done" | "error";

// RFC 6902-shaped op bundled with origin metadata. Emitted as tool-call args
// stream in, so the UI can build the card element-by-element instead of
// waiting 10-30s for the whole spec to complete.
//
// Paths use JSON Pointer (RFC 6901): "/meta", "/state", "/data", "/root",
// "/elements/<id>". Clients apply ops to a local spec mirror.
export interface PatchEntry {
  seq: number;
  at: number;
  source: "patch_spec";
  ops: Array<{
    op: "add" | "replace" | "remove" | "move" | "copy";
    path: string;
    value?: unknown;
    from?: string;
  }>;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

export interface StudioProjectState {
  projectId: string | null;
  activeStreamId: string | null;
  activeMessageId: string | null;
  lastStartedAt: number | null;
}

export type LegacyChatStartRequest = StartRequest;

export class StudioProjectAgent extends Agent<Env, StudioProjectState> {
  initialState: StudioProjectState = {
    projectId: null,
    activeStreamId: null,
    activeMessageId: null,
    lastStartedAt: null,
  };

  private status: Status = "streaming";
  private content = "";
  private error: string | null = null;
  private totals = { inputTokens: 0, outputTokens: 0 };
  private meta: StartRequest | null = null;
  private emittedSpec: unknown = null;
  private emittedSpecNote: string | null = null;
  // Monotonic counter bumped each time emittedSpec is reassigned. Lets poll
  // clients cheaply detect mid-turn spec updates (creation + subsequent
  // patch_specs can all arrive in the same streaming turn) without diffing.
  private emittedSpecVersion = 0;
  private emittedQuestions: unknown = null;
  private phase = "Thinking";
  private phaseHistory: string[] = [];
  private currentRound = 0;
  private toolCache = new Map<string, string>();

  // Server-side liveness signal. Bumped on every stream event (including
  // tool_call argument deltas that don't produce user-visible text).
  private lastEventAt = Date.now();

  // Phase-2 patch streaming state. patchLog grows as tool-call arguments
  // stream in and the partial-spec parser finds complete elements / ops.
  // Persisted in snapshot so rehydrated DOs don't drop previews mid-turn.
  private patchLog: PatchEntry[] = [];
  private patchSeq = 0;
  // Transient (not persisted): one partial parser per active spec-producing
  // tool call, keyed by the tool_call index from the stream.
  private toolParsers = new Map<
    number,
    { kind: "patch_spec"; parser: import("../lib/partial-spec.js").PartialSpecParser }
  >();
  // Elements already emitted per tool call — prevents duplicate patches if a
  // parser re-fires the same element (shouldn't happen, but cheap to guard).
  private toolEmittedIds = new Map<number, Set<string>>();

  // Active fiber context for the in-flight turn. Set inside `runFiber`'s
  // callback, cleared in `finally`. `stashSnapshot` writes a checkpoint via
  // this; if the DO is evicted between checkpoints, `onFiberRecovered` will
  // see the last stash on the next activation.
  private currentFiber: FiberContext | null = null;


  // ---- Phase-2 patch streaming --------------------------------------------

  // Opens a partial parser for a patch_spec tool-call index. No-op for other tools.
  private maybeStartPartialParser(idx: number, name: string): void {
    if (name === "patch_spec") {
      this.toolParsers.set(idx, { kind: "patch_spec", parser: createParser("patch_spec") });
    }
  }

  // Feeds an argument chunk to the parser (if one is active for the index)
  // and translates any emitted events into patchLog entries.
  private feedPartialParser(idx: number, chunk: string): void {
    const entry = this.toolParsers.get(idx);
    if (!entry) return;
    const t0 = Date.now();
    const events = entry.parser.push(chunk);
    const dt = Date.now() - t0;
    if (dt > 50) {
      // Parser shouldn't take this long on any normal chunk. Log so we can
      // spot pathological cases in production.
      console.warn("[studio-project-agent] slow parser push", {
        kind: entry.kind,
        chunkLen: chunk.length,
        dt,
        events: events.length,
      });
    }
    if (events.length === 0) return;

    for (const ev of events) {
      if (ev.type === "element") {
        const already = this.toolEmittedIds.get(idx);
        if (already && already.has(ev.id)) continue;
        if (already) already.add(ev.id);
        this.appendPatch(entry.kind, [
          { op: "add", path: `/elements/${escapeJsonPointer(ev.id)}`, value: ev.node },
        ]);
      } else if (ev.type === "meta") {
        // Shell contains meta/state/data/root — emit each as a separate add
        // so a newly-connecting client can rebuild from an empty object.
        const shell = ev.shell;
        const ops: PatchEntry["ops"] = [
          { op: "add", path: "/elements", value: {} },
        ];
        if ("meta" in shell) ops.unshift({ op: "add", path: "/meta", value: shell.meta });
        if ("state" in shell) ops.unshift({ op: "add", path: "/state", value: shell.state });
        if ("data" in shell) ops.unshift({ op: "add", path: "/data", value: shell.data });
        if ("root" in shell) ops.unshift({ op: "add", path: "/root", value: shell.root });
        this.appendPatch(entry.kind, ops);
      } else if (ev.type === "op") {
        // patch_spec forwards the op 1:1 to clients — the ops already operate
        // on the currently-stored spec shape.
        const raw = ev.op as Record<string, unknown>;
        const opName = raw.op;
        if (
          typeof opName === "string" &&
          (opName === "add" || opName === "replace" || opName === "remove" ||
           opName === "move" || opName === "copy")
        ) {
          this.appendPatch(entry.kind, [
            {
              op: opName,
              path: String(raw.path ?? ""),
              ...("value" in raw ? { value: raw.value } : {}),
              ...("from" in raw ? { from: String(raw.from) } : {}),
            },
          ]);
        }
      }
    }
  }

  // Build the poll-response `patches` payload. Returns null when the client
  // didn't request patches (no cursor) or when there's nothing new. The
  // payload shape mirrors how `append`/`nextOffset` work for text.
  private buildPatchesPayload(since: number | null): {
    since: number;
    log: PatchEntry[];
    nextCursor: number;
    truncated: boolean;
  } | null {
    if (since == null) return null;
    if (this.patchLog.length === 0) {
      return { since, log: [], nextCursor: this.patchSeq, truncated: false };
    }
    const MAX_PER_POLL = 500;
    const fresh = this.patchLog.filter((e) => e.seq > since);
    const truncated = fresh.length > MAX_PER_POLL;
    const slice = truncated ? fresh.slice(0, MAX_PER_POLL) : fresh;
    const nextCursor =
      slice.length > 0 ? slice[slice.length - 1].seq : Math.max(since, this.patchSeq);
    return { since, log: slice, nextCursor, truncated };
  }

  private appendPatch(source: PatchEntry["source"], ops: PatchEntry["ops"]): void {
    if (ops.length === 0) return;
    this.patchSeq++;
    this.patchLog.push({ seq: this.patchSeq, at: Date.now(), source, ops });
    this.lastEventAt = Date.now();
    // Cap memory — a very chatty turn shouldn't grow this unbounded.
    if (this.patchLog.length > 5000) {
      this.patchLog.splice(0, this.patchLog.length - 5000);
    }
    // Terse log so wrangler tail shows the patch stream rate. One line per
    // emission — at 50 elements in a turn, that's 50 lines, acceptable.
    const first = ops[0];
    console.log("[studio-project-agent] patch", {
      seq: this.patchSeq,
      source,
      ops: ops.length,
      firstOp: first?.op,
      firstPath: first?.path,
    });
    this.maybePersist();
  }

  // ------------------------------------------------------------------------

  private maybePersist(_force = false): void {
    // Stream Relay persists the public stream buffer/events. The Agent keeps
    // in-memory turn state while it is actively polled; durable project/chat
    // state is written to D1 by the tool handlers and completion path.
  }

  // Synchronous SQLite checkpoint via runFiber's FiberContext. No-op if
  // called outside a fiber (e.g. tests or future code paths). Captures only
  // what `onFiberRecovered` needs — partial content, status, and the meta
  // required to find the D1 message row.
  private stashSnapshot(): void {
    if (!this.currentFiber) return;
    this.currentFiber.stash({
      content: this.content,
      status: this.status,
      error: this.error,
      currentRound: this.currentRound,
      meta: this.meta,
      stashedAt: Date.now(),
    });
  }

  // Called by the Agents SDK on DO activation when an interrupted fiber is
  // detected (e.g. CPU eviction or deploy mid-turn). The in-memory `content`,
  // `patchLog`, etc. are gone — but the last stashed snapshot is in
  // `ctx.snapshot`. We use it to update the D1 `messages` row so the UI
  // sees an errored message with the partial output + retry notice instead
  // of polling forever against a dead `streaming` row.
  async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    const snap = ctx.snapshot as
      | {
          content?: string;
          status?: Status;
          meta?: StartRequest;
          currentRound?: number;
        }
      | null;
    const ageMs = Date.now() - ctx.createdAt;
    if (!snap?.meta?.messageId) {
      console.warn("[studio-project-agent] fiber recovered without meta — nothing to update", {
        fiberId: ctx.id,
        name: ctx.name,
        ageMs,
      });
      return;
    }
    // If the fiber stashed `done` or `error` before eviction, the terminal D1
    // write already happened — no recovery needed.
    if (snap.status === "done" || snap.status === "error") {
      console.log("[studio-project-agent] fiber recovered in terminal state, skipping", {
        fiberId: ctx.id,
        messageId: snap.meta.messageId,
        status: snap.status,
        ageMs,
      });
      return;
    }
    const partial = (snap.content ?? "").trim();
    const notice =
      "_Studio was interrupted (likely a deploy or restart). Please retry — partial output above if any._";
    const final = partial.length > 0 ? `${partial}\n\n${notice}` : notice;
    console.warn("[studio-project-agent] recovering interrupted fiber", {
      fiberId: ctx.id,
      name: ctx.name,
      messageId: snap.meta.messageId,
      round: snap.currentRound,
      partialLen: partial.length,
      ageMs,
    });
    try {
      await this.env.DB.prepare(
        `UPDATE messages SET content = ?, status = 'error' WHERE id = ? AND status = 'streaming'`,
      )
        .bind(final, snap.meta.messageId)
        .run();
    } catch (err) {
      console.error("[studio-project-agent] recovery DB write failed", err);
    }
  }


  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/start") {
      const body = (await req.json()) as StartRequest;
      this.status = "streaming";
      this.content = "";
      this.error = null;
      this.totals = { inputTokens: 0, outputTokens: 0 };
      this.emittedSpec = null;
      this.emittedSpecNote = null;
      this.emittedSpecVersion = 0;
      this.emittedQuestions = null;
      this.phase = "Thinking";
      this.phaseHistory = [];
      this.currentRound = 0;
      this.toolCache.clear();
      this.lastEventAt = Date.now();
      this.patchLog = [];
      this.patchSeq = 0;
      this.toolParsers.clear();
      this.toolEmittedIds.clear();
      this.meta = body;
      this.setState({
        ...this.state,
        projectId: body.projectId,
        activeStreamId: body.messageId,
        activeMessageId: body.messageId,
        lastStartedAt: Date.now(),
      });
      this.maybePersist(true);
      this.ctx.waitUntil(this.runConversation(body));
      return new Response(JSON.stringify({ status: this.status }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (req.method === "GET" && url.pathname === "/poll") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const append = this.content.slice(since);

      // Phase-2 patch cursor. Clients send `patchesSince=<maxSeq>`; the DO
      // returns new entries (seq > since). Cap payload at 500 entries so a
      // burst doesn't blow up one poll response — the client just catches up
      // on the next tick.
      const patchesSinceParam = url.searchParams.get("patchesSince");
      const patchesSince = patchesSinceParam == null ? null : Number(patchesSinceParam);
      const patchPayload = this.buildPatchesPayload(patchesSince);

      return Response.json({
        status: this.status,
        phase: this.phase,
        phaseHistory: this.phaseHistory,
        append,
        nextOffset: this.content.length,
        lastEventAt: this.lastEventAt,
        serverNow: Date.now(),
        ...(patchPayload ? { patches: patchPayload } : {}),
        // Stream spec updates mid-turn. Poll clients should re-render the
        // canvas whenever specVersion changes rather than waiting for `done`.
        ...(this.emittedSpec && this.emittedSpecVersion > 0
          ? {
              spec: this.emittedSpec,
              specNote: this.emittedSpecNote,
              specVersion: this.emittedSpecVersion,
            }
          : {}),
        ...(this.status === "done"
          ? {
              usage: {
                inputTokens: this.totals.inputTokens,
                outputTokens: this.totals.outputTokens,
                model: this.meta?.model,
              },
              ...(this.emittedQuestions
                ? { questions: this.emittedQuestions }
                : {}),
            }
          : {}),
        ...(this.error ? { error: this.error } : {}),
      });
    }
    if (req.method === "GET" && url.pathname === "/diagnostic") {
      return Response.json({
        status: this.status,
        contentLength: this.content.length,
        phase: this.phase,
        phaseHistory: this.phaseHistory,
        currentRound: this.currentRound,
        totals: this.totals,
        lastEventAt: this.lastEventAt,
        msSinceLastEvent: Date.now() - this.lastEventAt,
        error: this.error,
        emittedSpec: Boolean(this.emittedSpec),
        emittedQuestions: Boolean(this.emittedQuestions),
        meta: this.meta
          ? {
              hubId: this.meta.hubId,
              projectId: this.meta.projectId,
              chatId: this.meta.chatId,
              messageId: this.meta.messageId,
              model: this.meta.model,
            }
          : null,
      });
    }
    return new Response("Not found", { status: 404 });
  }

  private async runConversation(req: StartRequest): Promise<void> {
    // Wrap the whole turn in a fiber so an eviction mid-stream produces a
    // recoverable SQLite row that `onFiberRecovered` can act on. Snapshots
    // are stashed at round boundaries via `stashSnapshot()`.
    await this.runFiber(`studio-turn-${req.messageId}`, async (fctx) => {
      this.currentFiber = fctx;
      try {
        await this.runConversationInner(req);
      } finally {
        this.currentFiber = null;
      }
    });
  }

  private async runConversationInner(req: StartRequest): Promise<void> {
    const runStartedAt = Date.now();
    const logCtx = {
      messageId: req.messageId,
      chatId: req.chatId,
      projectId: req.projectId,
      model: req.model,
    };
    console.log("[studio-project-agent] start", logCtx);
    this.logEvent(req, "run_start", {
      model: req.model,
      historyTurns: req.messages.length,
    });
    // Initial stash — guarantees the fiber row has `meta` (and thus the
    // messageId) before the first network call. If the LLM connection itself
    // dies and the DO is evicted, recovery still has enough to update D1.
    this.stashSnapshot();
    try {
      const client = createLLMClient(this.env, req.model, {
        hubId: req.hubId,
        chatId: req.chatId,
        messageId: req.messageId,
      });

      // Build the system message once. OpenAI-compat has no per-block cache
      // markers, so static + spec concatenate into a single system entry.
      const systemContent = req.systemSpec
        ? `${req.systemStatic}\n\n${req.systemSpec}`
        : req.systemStatic;

      // Running conversation history for this completion. Starts with the
      // persisted user-visible turns; grows with assistant (with tool_calls)
      // and tool-role messages as we loop.
      const running: ChatMessage[] = req.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        this.currentRound = round;
        this.phase = "Thinking";

        const messages = [
          { role: "system" as const, content: systemContent },
          ...running,
        ];
        // Log request shape per round so we can see payload growth. Useful
        // for diagnosing round-1+ failures where the accumulating history
        // blows past a size limit or includes a malformed prior turn.
        const roleCounts = messages.reduce<Record<string, number>>((acc, m) => {
          acc[m.role] = (acc[m.role] ?? 0) + 1;
          return acc;
        }, {});
        const serialized = JSON.stringify(messages);
        console.log("[studio-project-agent] round_request", {
          round,
          messageId: req.messageId,
          roleCounts,
          messageCount: messages.length,
          payloadBytes: serialized.length,
        });
        this.logEvent(req, "round_request", {
          round,
          roleCounts,
          messageCount: messages.length,
          payloadBytes: serialized.length,
        });

        // Anthropic and OpenAI via the unified gateway only emit a
        // final chunk with `usage` when stream_options.include_usage is
        // true. Workers AI's compat shim rejects unknown fields, so we
        // skip the option for the workers-ai/ prefix and accept that
        // those rounds may report 0 tokens.
        const includeUsage = !req.model.startsWith("workers-ai/");
        const stream = await client.chat.completions.create({
          model: req.model,
          // 32k output budget. Enough headroom for Sonnet to emit full
          // specs + reasoning and for reasoning models (Kimi) to spend tokens
          // thinking before output. Bump if "Hit the output-token cap"
          // appears in chat replies.
          max_completion_tokens: 32768,
          messages,
          tools: TOOL_DEFINITIONS as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
          stream: true,
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        });

        // Stream deltas. delta.content is user-visible text; delta.tool_calls
        // are partial tool-call objects indexed by array position — arguments
        // arrive as chunks of a JSON string that we concatenate.
        let assistantText = "";
        const toolAccum = new Map<number, ToolCall>();
        let finishReason: string | null = null;
        let hadTextInThisRound = false;
        // Reasoning / chain-of-thought capture. Kimi K2.6 (and other reasoning
        // models via the Workers AI compat shim) stream thoughts on
        // `delta.reasoning_content` or `delta.reasoning`. Neither is
        // user-visible, but logging a trickle of it proves the model is alive
        // during long silent gaps before the first content/tool_call chunk.
        let reasoningBuf = "";
        let reasoningCharsSinceFlush = 0;
        let reasoningLastFlushAt = 0;
        let reasoningStartedAt = 0;
        const flushReasoning = (final: boolean) => {
          if (reasoningBuf.length === 0) return;
          const snippet = reasoningBuf.slice(-180);
          this.logEvent(req, final ? "thinking_done" : "thinking", {
            round,
            chars: reasoningBuf.length,
            sinceLastFlush: reasoningCharsSinceFlush,
            snippet,
          });
          reasoningCharsSinceFlush = 0;
          reasoningLastFlushAt = Date.now();
        };

        for await (const chunk of stream) {
          this.lastEventAt = Date.now();
          const choice = chunk.choices?.[0];
          if (!choice) {
            // Final chunk with only usage info.
            if (chunk.usage) {
              this.totals.inputTokens += chunk.usage.prompt_tokens ?? 0;
              this.totals.outputTokens += chunk.usage.completion_tokens ?? 0;
            }
            continue;
          }
          const delta = choice.delta as
            | (typeof choice.delta & { reasoning_content?: string; reasoning?: string })
            | undefined;
          const reasoningChunk =
            (typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "") ||
            (typeof delta?.reasoning === "string" ? delta.reasoning : "");
          if (reasoningChunk) {
            if (reasoningBuf.length === 0) {
              reasoningStartedAt = Date.now();
              this.phase = "Thinking…";
              this.maybePersist(true);
            }
            reasoningBuf += reasoningChunk;
            reasoningCharsSinceFlush += reasoningChunk.length;
            const now = Date.now();
            if (
              reasoningCharsSinceFlush >= 500 ||
              (reasoningLastFlushAt > 0 && now - reasoningLastFlushAt >= 2000) ||
              (reasoningLastFlushAt === 0 && now - reasoningStartedAt >= 1000)
            ) {
              flushReasoning(false);
            }
          }
          if (delta?.content) {
            if (
              !hadTextInThisRound &&
              this.content.length > 0 &&
              !this.content.endsWith("\n\n")
            ) {
              this.content += this.content.endsWith("\n") ? "\n" : "\n\n";
            }
            this.content += delta.content;
            assistantText += delta.content;
            hadTextInThisRound = true;
            this.maybePersist();
          }
          if (delta && Array.isArray((delta as { tool_calls?: unknown }).tool_calls)) {
            const deltas = (delta as { tool_calls: Array<Partial<ToolCall> & { index: number }> })
              .tool_calls;
            for (const tc of deltas) {
              const idx = tc.index;
              const existing = toolAccum.get(idx);
              if (!existing) {
                const created: ToolCall = {
                  id: tc.id ?? "",
                  type: "function",
                  function: {
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? "",
                  },
                };
                toolAccum.set(idx, created);
                // First delta for this tool_call usually carries the name —
                // surface a phase update right away so the UI shows progress
                // while arguments stream in.
                if (tc.function?.name) {
                  this.phase = phaseLabelFor(tc.function.name, {});
                  this.maybePersist(true);
                  this.maybeStartPartialParser(idx, tc.function.name);
                }
                // Some providers send args in the very first delta. Feed them.
                if (tc.function?.arguments) {
                  this.feedPartialParser(idx, tc.function.arguments);
                }
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) {
                  existing.function.name = tc.function.name;
                  // Name arrived after args started — bootstrap parser now and
                  // replay everything we've accumulated so far.
                  if (!this.toolParsers.has(idx)) {
                    this.maybeStartPartialParser(idx, tc.function.name);
                    if (existing.function.arguments) {
                      this.feedPartialParser(idx, existing.function.arguments);
                    }
                  }
                }
                if (tc.function?.arguments) {
                  existing.function.arguments += tc.function.arguments;
                  this.feedPartialParser(idx, tc.function.arguments);
                }
              }
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            this.totals.inputTokens += chunk.usage.prompt_tokens ?? 0;
            this.totals.outputTokens += chunk.usage.completion_tokens ?? 0;
          }
        }

        const toolCalls = Array.from(toolAccum.values());
        // Partial parsers are per-round — the round's stream has ended, so
        // no more arg deltas are coming. Free the brace-tracking state; the
        // authoritative spec parse happens below via JSON.parse.
        this.toolParsers.clear();
        this.toolEmittedIds.clear();
        flushReasoning(true);

        console.log("[studio-project-agent] round_end", {
          ...logCtx,
          round,
          finishReason,
          toolCalls: toolCalls.length,
          contentLength: this.content.length,
          elapsedMs: Date.now() - runStartedAt,
        });
        this.logEvent(req, "round_end", {
          round,
          finish_reason: finishReason,
          tool_calls: toolCalls.length,
        });
        // Checkpoint after each round — captures partial `content` plus the
        // round counter so a recovery sees how far we got.
        this.stashSnapshot();

        // End of turn — no tool calls, or any terminal finish_reason.
        if (finishReason !== "tool_calls") {
          if (finishReason === "length") {
            // Output-cap hit mid-response. Surface it instead of ending
            // silently with only the preamble.
            const notice =
              "\n\n_Hit the output-token cap before finishing. Ask me to continue or try patch_spec for incremental edits._";
            this.content = (this.content.trimEnd() + notice).trim();
            this.maybePersist(true);
          }
          break;
        }

        // Echo the assistant turn back into the running history (content may
        // be empty — a tool-only turn.) OpenAI requires the tool_calls array
        // to be present on an assistant message whose next peer is a tool
        // message. We use "" rather than null for the content field because
        // some OpenAI-compat backends (Workers AI among them) reject null
        // on incoming assistant messages even though the spec allows it.
        running.push({
          role: "assistant",
          content: assistantText,
          tool_calls: toolCalls,
        });

        // Execute each tool_call. Each one gets ONE tool-role message in
        // response, pushed in the same order, so tool_call_id pairing is
        // unambiguous.
        let truncatedToolArgs = false;
        for (const tc of toolCalls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
          } catch (err) {
            const argsLen = tc.function.arguments?.length ?? 0;
            const head = (tc.function.arguments ?? "").slice(0, 200);
            const tail = (tc.function.arguments ?? "").slice(-200);
            console.error("[studio-project-agent] malformed tool arguments", {
              tool: tc.function.name,
              tool_call_id: tc.id,
              argsLen,
              head,
              tail,
              err: err instanceof Error ? err.message : String(err),
            });
            this.logEvent(req, "tool_args_malformed", {
              tool: tc.function.name,
              tool_call_id: tc.id,
              argsLen,
              head: head.slice(0, 100),
              tail: tail.slice(-200),
              err: err instanceof Error ? err.message : String(err),
            });
            // Malformed args almost always mean the model ran out of output
            // tokens mid-JSON. Feeding the broken assistant turn back to the
            // provider on the next round triggers an opaque 400 (no body) on
            // Workers AI, so short-circuit: surface a user-visible notice and
            // end the run. `running` is discarded on break, so the truncated
            // assistant message never leaves this function.
            const notice = `\n\n_The model's ${tc.function.name} call was cut off mid-JSON (${argsLen} chars). Likely hit the output-token cap — ask me to continue or try patch_spec for incremental edits._`;
            this.content = (this.content.trimEnd() + notice).trim();
            this.maybePersist(true);
            truncatedToolArgs = true;
            break;
          }

          this.phase = phaseLabelFor(tc.function.name, input);
          this.phaseHistory.push(this.phase);
          this.maybePersist(true);
          await this.logToolCall(req, tc.function.name, input);

          const resultContent = await this.executeTool(tc.function.name, input, req);
          running.push({
            role: "tool",
            tool_call_id: tc.id,
            content: resultContent,
          });
        }

        // ask_questions ends the turn.
        if (this.emittedQuestions) break;

        // Truncated tool-call JSON — don't round-trip the broken assistant
        // turn. Notice already appended; exit cleanly as a `done` turn.
        if (truncatedToolArgs) break;

        if (round === MAX_TOOL_ROUNDS - 1) {
          this.content =
            (this.content.length > 0 ? this.content + "\n\n" : "") +
            TOOL_CAP_NOTICE;
        }
      }

      this.phase = "Done";
      this.status = "done";

      if (this.content.trim().length === 0) {
        this.content = EMPTY_CONTENT_FALLBACK;
      }
      this.maybePersist(true);
      // Stash terminal `done` state — recovery will then short-circuit since
      // the D1 row is about to be updated authoritatively below.
      this.stashSnapshot();

      await this.env.DB.prepare(
        `UPDATE messages SET content = ?, status = 'done' WHERE id = ?`,
      )
        .bind(this.content, req.messageId)
        .run();

      console.log("[studio-project-agent] done", {
        ...logCtx,
        elapsedMs: Date.now() - runStartedAt,
        contentLength: this.content.length,
        inputTokens: this.totals.inputTokens,
        outputTokens: this.totals.outputTokens,
      });
      this.logEvent(req, "run_done", {
        elapsedMs: Date.now() - runStartedAt,
        contentLength: this.content.length,
        in: this.totals.inputTokens,
        out: this.totals.outputTokens,
      });

      await logUsage(this.env, {
        id: crypto.randomUUID(),
        hubId: req.hubId,
        chatId: req.chatId,
        messageId: req.messageId,
        projectId: req.projectId,
        model: req.model,
        inputTokens: this.totals.inputTokens,
        outputTokens: this.totals.outputTokens,
        estimatedCostCents: estimateCostCents(
          req.model,
          this.totals.inputTokens,
          this.totals.outputTokens,
        ),
        estimatedCostMicroCents: estimateCostMicroCents(
          req.model,
          this.totals.inputTokens,
          this.totals.outputTokens,
        ),
      });
    } catch (err) {
      const elapsedMs = Date.now() - runStartedAt;
      // Detailed error inspection — the SDK wraps provider errors with a
      // status and (sometimes) a response body. Extract both so the D1 log
      // captures enough to diagnose 400s without round-tripping to wrangler tail.
      const errAny = err as {
        status?: number;
        code?: string;
        message?: string;
        error?: unknown;
        response?: { status?: number; headers?: unknown };
      };
      console.error("[studio-project-agent] runConversation threw", {
        ...logCtx,
        elapsedMs,
        round: this.currentRound,
        contentLength: this.content.length,
        status: errAny.status,
        code: errAny.code,
        providerError: errAny.error,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      this.logEvent(req, "run_error", {
        elapsedMs,
        round: this.currentRound,
        contentLength: this.content.length,
        error: err instanceof Error ? err.message : String(err),
      });
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      const partial = this.content.trim();
      const notice = `_Studio hit an error: ${this.error}. Please retry — partial output above if any._`;
      this.content = partial.length > 0 ? `${partial}\n\n${notice}` : notice;
      this.maybePersist(true);
      // Stash terminal error state so `onFiberRecovered` skips this fiber if
      // an eviction happens between here and the D1 write below.
      this.stashSnapshot();
      if (this.meta) {
        await this.env.DB.prepare(
          `UPDATE messages SET content = ?, status = 'error' WHERE id = ?`,
        )
          .bind(this.content, this.meta.messageId)
          .run()
          .catch(() => {});
      }
    }
  }

  // Dispatches one tool call and returns a JSON string suitable for the
  // tool-role message `content` field. Centralizes the branching for tools
  // that have I/O side effects (patch_spec, ask_questions) vs.
  // pure knowledge-base reads.
  private async executeTool(
    name: string,
    input: Record<string, unknown>,
    req: StartRequest,
  ): Promise<string> {
    if (name === "ask_questions") {
      return JSON.stringify(this.handleAskQuestions(input).value);
    }
    if (name === "patch_spec") {
      const r = await this.handlePatchSpec(input, req);
      return JSON.stringify(r.value);
    }
    const cacheKey = CACHEABLE_TOOLS.has(name) ? cacheKeyFor(name, input) : null;
    const cached = cacheKey ? this.toolCache.get(cacheKey) : undefined;
    if (cached !== undefined) {
      return `__cached__ (same result as your earlier ${name} call in this turn — don't re-call)\n\n${cached}`;
    }
    const result = dispatchTool(name, input);
    const serialized = JSON.stringify(result.value);
    if (cacheKey && result.ok) this.toolCache.set(cacheKey, serialized);
    return serialized;
  }

  private handleAskQuestions(
    input: Record<string, unknown>,
  ): { ok: boolean; value: unknown } {
    const raw = input.questions;
    if (!Array.isArray(raw) || raw.length === 0) {
      return {
        ok: false,
        value: { ok: false, error: "questions must be a non-empty array" },
      };
    }
    const allowedTypes = new Set([
      "short-text",
      "long-text",
      "single-select",
      "multi-select",
    ]);
    const normalized: Array<Record<string, unknown>> = [];
    for (let i = 0; i < raw.length; i++) {
      const q = raw[i];
      if (!q || typeof q !== "object") {
        return { ok: false, value: { ok: false, error: `questions[${i}] must be an object` } };
      }
      const obj = q as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id : null;
      const type = typeof obj.type === "string" ? obj.type : null;
      const prompt = typeof obj.prompt === "string" ? obj.prompt : null;
      if (!id || !type || !prompt) {
        return {
          ok: false,
          value: { ok: false, error: `questions[${i}] needs id, type, prompt` },
        };
      }
      if (!allowedTypes.has(type)) {
        return {
          ok: false,
          value: {
            ok: false,
            error: `questions[${i}].type must be one of short-text | long-text | single-select | multi-select`,
          },
        };
      }
      if (type === "single-select" || type === "multi-select") {
        if (!Array.isArray(obj.options) || obj.options.length === 0) {
          return {
            ok: false,
            value: {
              ok: false,
              error: `questions[${i}] is ${type}; options[] required`,
            },
          };
        }
      }
      normalized.push(obj);
    }
    this.emittedQuestions = normalized;
    return {
      ok: true,
      value: {
        ok: true,
        delivered: normalized.length,
        note: "Questions sent to the user. End the turn now — do not create a spec yet. The user's answers will arrive as the next user message.",
      },
    };
  }

  private logEvent(
    req: StartRequest,
    event: string,
    detail: Record<string, unknown>,
  ): void {
    const id = `se-${crypto.randomUUID()}`;
    let serialized: string;
    try {
      serialized = JSON.stringify(detail);
    } catch {
      serialized = "{}";
    }
    if (serialized.length > 1000) serialized = serialized.slice(0, 997) + "...";
    this.ctx.waitUntil(
      this.env.DB.prepare(
        `INSERT INTO stream_events (id, chat_id, message_id, round, event, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          req.chatId,
          req.messageId,
          this.currentRound,
          event,
          serialized,
          Date.now(),
        )
        .run()
        .catch((err) =>
          console.error("[studio-project-agent] stream_events insert failed", err),
        ),
    );
  }

  private async logToolCall(
    req: StartRequest,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const id = `tc-${crypto.randomUUID()}`;
    let preview: string;
    try {
      preview = JSON.stringify(input);
    } catch {
      preview = "(unserializable input)";
    }
    if (preview.length > 500) preview = preview.slice(0, 497) + "...";
    try {
      await this.env.DB.prepare(
        `INSERT INTO tool_calls (id, chat_id, message_id, round, tool_name, input_preview, ok, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
      )
        .bind(
          id,
          req.chatId,
          req.messageId,
          this.currentRound,
          toolName,
          preview,
          Date.now(),
        )
        .run();
    } catch (err) {
      console.error("[studio-project-agent] tool_calls insert failed:", err);
    }
  }

  private async handlePatchSpec(
    input: Record<string, unknown>,
    req: StartRequest,
  ): Promise<{ ok: boolean; value: unknown }> {
    const ops = input.ops;
    const note = typeof input.note === "string" ? input.note : null;
    if (!Array.isArray(ops) || ops.length === 0) {
      return {
        ok: false,
        value: { ok: false, error: "ops must be a non-empty array" },
      };
    }

    const row = await this.env.DB.prepare(
      `SELECT json FROM specs WHERE project_id = ?`,
    )
      .bind(req.projectId)
      .first<{ json: string }>();
    let base: unknown;
    if (!row) {
      // patch_spec is also the creation tool. Starting from an empty v1 shell
      // lets the model create a card with one atomic full-rewrite patch:
      // replace /meta, /state, /data, /root, and /elements.
      base = { meta: {}, state: {}, data: {}, root: "card-root", elements: {} };
    } else {
      try {
        base = JSON.parse(row.json);
      } catch {
        return { ok: false, value: { ok: false, error: "stored spec JSON is malformed" } };
      }
    }

    const result = applyPatch(base, ops as PatchOp[]);
    if (!result.ok) {
      return {
        ok: false,
        value: {
          ok: false,
          error: result.error,
          failedIndex: result.failedIndex,
        },
      };
    }

    const { warnings: repairWarnings } = repairSpec(result.value);
    const validation = validateSpec(result.value);
    if (!validation.ok) {
      return {
        ok: false,
        value: {
          ok: false,
          error: "patched spec failed validation — no changes saved",
          validationErrors: validation.errors,
        },
      };
    }

    try {
      const now = Date.now();
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO specs (project_id, json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        ).bind(req.projectId, JSON.stringify(result.value), now),
        this.env.DB.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(
          now,
          req.projectId,
        ),
      ]);
      this.emittedSpec = result.value;
      this.emittedSpecNote = note;
      this.emittedSpecVersion += 1;
      this.maybePersist(true);
      return {
        ok: true,
        value: {
          ok: true,
          applied: ops.length,
          spec: result.value,
          ...(repairWarnings.length > 0 ? { repairs: repairWarnings } : {}),
        },
      };
    } catch (err) {
      return {
        ok: false,
        value: {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

// RFC 6901 JSON Pointer escaping. An element ID may contain `/` or `~`, both
// of which have special meaning in JSON Pointer paths.
function escapeJsonPointer(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}
