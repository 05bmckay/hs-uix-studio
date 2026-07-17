// Thin client for the Studio Cloudflare Worker. Centralizes:
//   - base URL (from config.WORKER_URL)
//   - dev-mode auth headers (X-Studio-Hub-Id / X-Studio-User-Id)
//   - JSON serialization
//   - error normalization
//
// In production hubspot.fetch() carries HubSpot's signed request context and
// the worker verifies that — dev headers are a fallback for local testing.
//
// Every method returns parsed JSON on 2xx, throws WorkerError on non-2xx or
// network failure. Callers should wrap in try/catch and surface to the UI.

import { Effect } from "effect";
import { hubspot } from "@hubspot/ui-extensions";
import { WORKER_URL } from "../config.js";

export class WorkerError extends Error {
  constructor(status, code, message) {
    super(message || code || `worker ${status}`);
    this.status = status;
    this.code = code;
  }
}

function toWorkerError(error) {
  if (error instanceof WorkerError) return error;
  // hubspot.fetch rejects on non-2xx with a structured error: the upstream
  // body is on .responseBody and the upstream status is on
  // .context.appServerStatusCode (string-wrapped). Pull them through so
  // callers can branch on the real code (e.g. credit_exhausted / 402)
  // instead of seeing a generic "network" error.
  const ctx = error?.context;
  const upstreamStatus = Number(
    Array.isArray(ctx?.appServerStatusCode) ? ctx.appServerStatusCode[0] : ctx?.appServerStatusCode,
  );
  const body = error?.responseBody;
  if (body && typeof body === "object" && (body.error || body.message)) {
    return new WorkerError(
      Number.isFinite(upstreamStatus) ? upstreamStatus : 0,
      body.error ?? "error",
      body.message ?? String(body.error ?? "error"),
    );
  }
  return new WorkerError(0, "network", error instanceof Error ? error.message : String(error));
}

const requestEffect = (path, { method = "GET", body, auth } = {}) =>
  Effect.gen(function* () {
  if (!WORKER_URL) {
      yield* Effect.fail(
        new WorkerError(0, "backend_disabled", "WORKER_URL is not set"),
      );
  }
  const url = `${WORKER_URL}${path}`;
  // NOTE: hubspot.fetch() rejects *any* outbound header other than
  // Authorization (413 REQUEST_HEADERS_FIELDS_TOO_LARGE) — including
  // Accept and Content-Type. The worker parses the body as JSON via the
  // stream so Content-Type isn't required. Identity is carried by
  // HubSpot's signed-request headers (added server-side, verified in
  // lib/verify.ts). `auth` is ignored here; local dev needs curl directly.

    const res = yield* Effect.tryPromise({
      try: () =>
        hubspot.fetch(url, {
          method,
          // hubspot.fetch serializes body itself — pass the object, not a
          // pre-stringified string, otherwise we get a double-JSON-encoded payload.
          ...(body != null ? { body } : {}),
        }),
      catch: (error) => toWorkerError(error),
    });
  if (!res.ok) {
      const payload = yield* Effect.tryPromise(() => res.json()).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );
      yield* Effect.fail(
        new WorkerError(
          res.status,
          payload?.error ?? "error",
          payload?.message ?? res.statusText,
        ),
      );
  }
  // 204 or empty bodies
    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (error) => toWorkerError(error),
    });
    return text ? JSON.parse(text) : null;
  });

async function call(path, options) {
  return Effect.runPromise(requestEffect(path, options));
}

// --- Projects -------------------------------------------------------------

export const workerApi = {
  listProjects: (auth) => call("/projects", { auth }),
  createProject: (auth, { name, description }) =>
    call("/projects", { method: "POST", auth, body: { name, description } }),
  getProject: (auth, projectId) => call(`/projects/${projectId}`, { auth }),
  putSpec: (auth, projectId, spec) =>
    call(`/projects/${projectId}/spec`, { method: "PUT", auth, body: spec }),
  patchProject: (auth, projectId, fields) =>
    call(`/projects/${projectId}`, { method: "PATCH", auth, body: fields }),
  deleteProject: (auth, projectId) =>
    call(`/projects/${projectId}`, { method: "DELETE", auth }),

  // --- Chats -------------------------------------------------------------
  listChats: (auth, projectId) =>
    call(`/chats?projectId=${encodeURIComponent(projectId)}`, { auth }),
  createChat: (auth, { projectId, title }) =>
    call("/chats", { method: "POST", auth, body: { projectId, title } }),
  failMessage: (auth, messageId) =>
    call(`/chats/messages/${messageId}/fail`, { method: "POST", auth }),
  listMessages: (auth, chatId, { cursor, limit = 5 } = {}) => {
    const qs = new URLSearchParams();
    if (cursor != null) qs.set("cursor", String(cursor));
    qs.set("limit", String(limit));
    return call(`/chats/${chatId}/messages?${qs.toString()}`, { auth });
  },

  // --- Chat turn (kicks off streaming) ----------------------------------
  postChat: (auth, { projectId, chatId, userMessage }) =>
    call("/chat", {
      method: "POST",
      auth,
      body: { projectId, chatId, userMessage },
    }),

  // --- Comments ----------------------------------------------------------
  listComments: (auth, projectId) =>
    call(`/comments?projectId=${encodeURIComponent(projectId)}`, { auth }),
  createComment: (auth, { projectId, nodeId, nodeSummary, text }) =>
    call("/comments", {
      method: "POST",
      auth,
      body: { projectId, nodeId, nodeSummary, text },
    }),
  patchCommentStatus: (auth, commentId, status) =>
    call(`/comments/${commentId}`, {
      method: "PATCH",
      auth,
      body: { status },
    }),
  deleteComment: (auth, commentId) =>
    call(`/comments/${commentId}`, { method: "DELETE", auth }),

  // --- Exports -----------------------------------------------------------
  // Peek at the cached design doc without generating. Returns markdown
  // (nullable), staleness flag, has_spec, and spec_updated_at.
  getDesignDoc: (auth, projectId) =>
    call(`/export/${encodeURIComponent(projectId)}/design-doc`, { auth }),
  // Generate (or regenerate) the design doc. Cached per spec hash on the
  // server; pass `regenerate: true` to force a fresh model call.
  generateDesignDoc: (auth, projectId, { regenerate = false } = {}) =>
    call(
      `/export/${encodeURIComponent(projectId)}/design-doc${regenerate ? "?regenerate=1" : ""}`,
      { method: "POST", auth },
    ),

  // --- Usage / settings summary -----------------------------------------
  // `window` ∈ "7d" | "30d" | "all". Powers the Settings & Usage page.
  getUsageSummary: (auth, { window = "30d" } = {}) =>
    call(`/usage/summary?window=${encodeURIComponent(window)}`, { auth }),

  // --- Bring-your-own Anthropic key ---------------------------------------
  getAnthropicSettings: (auth) => call("/settings/anthropic", { auth }),
  setAnthropicKey: (auth, key) =>
    call("/settings/anthropic", { method: "POST", auth, body: { key } }),
  clearAnthropicKey: (auth) =>
    call("/settings/anthropic", { method: "DELETE", auth }),
  setChatModel: (auth, model) =>
    call("/settings/anthropic/model", { method: "PUT", auth, body: { model } }),

  // --- Knowledge catalog (prebuilt blocks + examples) --------------------
  getKnowledgeCatalog: (auth) => call("/knowledge/catalog", { auth }),
  getKnowledgeExample: (auth, name) =>
    call(`/knowledge/examples/${encodeURIComponent(name)}`, { auth }),
  getKnowledgeBlock: (auth, name) =>
    call(`/knowledge/blocks/${encodeURIComponent(name)}`, { auth }),
};
