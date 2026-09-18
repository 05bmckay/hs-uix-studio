import { Hono } from "hono";
import { oauthRoutes } from "./routes/oauth";
import { chatRoutes } from "./routes/chat";
import { streamRoutes } from "./routes/streams";
import { projectRoutes } from "./routes/projects";
import { chatThreadRoutes } from "./routes/chats";
import { commentRoutes } from "./routes/comments";
import { knowledgeRoutes } from "./routes/knowledge";
import { exportRoutes } from "./routes/export";
import { usageRoutes } from "./routes/usage";
import { settingsRoutes } from "./routes/settings";
import type { StudioProjectAgent } from "./agents/studio-project-agent";

export { ExportStream } from "./do/export-stream";
export { StudioRelay } from "./do/studio-relay";
export { StudioProjectAgent } from "./agents/studio-project-agent";

export interface Env {
  DB: D1Database;
  OAUTH_STATE: KVNamespace;
  AI: Ai;
  EXPORT_STREAM: DurableObjectNamespace;
  RELAY: DurableObjectNamespace;
  STUDIO_PROJECT_AGENT: DurableObjectNamespace<StudioProjectAgent>;

  // Secrets (bound via `wrangler secret put`)
  ANTHROPIC_API_KEY: string;
  // Only required when CHAT_MODEL uses the workers-ai/ prefix. Needs a
  // Cloudflare API token with Workers AI read scope.
  CLOUDFLARE_API_TOKEN?: string;
  // Only required when CHAT_MODEL uses the openai/ prefix.
  OPENAI_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_AI_GATEWAY_ID: string;
  CLOUDFLARE_AI_GATEWAY_TOKEN: string;
  HUBSPOT_CLIENT_ID: string;
  HUBSPOT_CLIENT_SECRET: string;
  HUBSPOT_APP_SCOPES: string;
  TOKEN_ENCRYPTION_KEY: string;
  WORKER_PUBLIC_URL: string;
  // Local-only fallback identity for HubSpot project dev's app-backend proxy.
  // The local proxy signs requests but does not always include portal/user
  // identity on GETs, so requireInstall can fall back to these when
  // WORKER_PUBLIC_URL points at localhost.
  LOCAL_HUB_ID?: string;
  LOCAL_USER_ID?: string;
  LOCAL_DEV_AUTH_BYPASS?: string;

  // Non-secret vars (wrangler.toml [vars])
  // Prefixed model string picked up by the AI Gateway unified endpoint.
  // e.g. "anthropic/claude-sonnet-4-6", "workers-ai/@cf/moonshotai/kimi-k2.6".
  CHAT_MODEL: string;
  STREAM_POLL_INTERVAL_MS: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("hs-uix-studio worker ok"));

app.route("/oauth", oauthRoutes);
app.route("/chat", chatRoutes);
app.route("/streams", streamRoutes);
app.route("/projects", projectRoutes);
app.route("/chats", chatThreadRoutes);
app.route("/comments", commentRoutes);
app.route("/knowledge", knowledgeRoutes);
app.route("/export", exportRoutes);
app.route("/usage", usageRoutes);
app.route("/settings", settingsRoutes);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error("[worker]", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default app;
