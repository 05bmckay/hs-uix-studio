// LLM clients wired through Cloudflare's AI Gateway. Two paths:
//
//   - anthropic/* models: native Anthropic Messages API via the gateway's
//     provider passthrough (`.../anthropic`). Request bodies pass through
//     verbatim, which is what makes `cache_control` prompt-caching markers
//     work (~0.1× input cost on cache reads) AND lets tool-call argument
//     deltas stream (the compat translation buffers them until the block
//     completes, killing progressive spec preview).
//   - everything else (workers-ai/*, openai/*): OpenAI-shaped client against
//     the unified/compat endpoint, chosen by the model string's prefix.
//     Those platforms do automatic prompt caching without markers.
//
// Docs: https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
//       https://developers.cloudflare.com/ai-gateway/usage/chat-completion/

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../index";

export interface GatewayCallContext {
  hubId: number;
  chatId: string;
  messageId: string;
}

// Pick the upstream API key based on the model's prefix. The unified endpoint
// forwards the Authorization header to the selected backend, so we need the
// right provider key for the model we're about to call.
export function apiKeyForModel(env: Env, model: string): string {
  const prefix = model.split("/")[0];
  switch (prefix) {
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
    case "workers-ai":
      // AI Gateway accepts a Cloudflare API token with Workers AI read scope.
      // If you haven't created one yet, `wrangler secret put CLOUDFLARE_API_TOKEN`.
      return env.CLOUDFLARE_API_TOKEN ?? "";
    case "openai":
      return env.OPENAI_API_KEY ?? "";
    default:
      throw new Error(
        `unknown model prefix "${prefix}" — expected anthropic/, workers-ai/, or openai/`,
      );
  }
}

export function createLLMClient(
  env: Env,
  model: string,
  ctx: GatewayCallContext,
): OpenAI {
  const baseURL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.CLOUDFLARE_AI_GATEWAY_ID}/compat`;
  return new OpenAI({
    apiKey: apiKeyForModel(env, model),
    baseURL,
    defaultHeaders: {
      // Gateway auth — required when "Authenticated Gateway" is on.
      "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_AI_GATEWAY_TOKEN}`,
      // Retry policy — overrides the dashboard default so retries are
      // consistent per request. 2 retries, 500ms base delay, exponential.
      "cf-aig-max-attempts": "3",
      "cf-aig-retry-delay": "500",
      // Surfaces in AI Gateway logs; lets us filter/search by portal.
      "cf-aig-metadata": JSON.stringify({
        hub_id: String(ctx.hubId),
        chat_id: ctx.chatId,
        message_id: ctx.messageId,
      }),
    },
  });
}

export function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/");
}

// Native Anthropic client through the AI Gateway provider passthrough.
// The SDK appends /v1/messages and sets x-api-key + anthropic-version itself;
// model strings on this path are BARE Anthropic IDs (strip the "anthropic/"
// prefix before calling).
export function createAnthropicClient(env: Env, ctx: GatewayCallContext): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.CLOUDFLARE_AI_GATEWAY_ID}/anthropic`,
    defaultHeaders: {
      // Without this beta, the API buffers a tool call's input JSON and
      // emits it in one burst when the block completes — which kills the
      // progressive element-by-element canvas preview. Fine-grained
      // streaming delivers input_json_delta as the model generates it.
      "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
      "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_AI_GATEWAY_TOKEN}`,
      "cf-aig-max-attempts": "3",
      "cf-aig-retry-delay": "500",
      // Chat requests must never be served from the gateway's exact-match
      // response cache — a replayed turn looks like fresh generation but
      // arrives in one burst and can be stale.
      "cf-aig-skip-cache": "true",
      "cf-aig-metadata": JSON.stringify({
        hub_id: String(ctx.hubId),
        chat_id: ctx.chatId,
        message_id: ctx.messageId,
      }),
    },
  });
}

// Pricing per 1M tokens (USD cents). Keys match the prefixed model string
// passed to chat.completions.create. Update when pricing changes.
const PRICING: Record<string, { inputCentsPerMTok: number; outputCentsPerMTok: number }> = {
  "anthropic/claude-opus-4-8":   { inputCentsPerMTok:  500, outputCentsPerMTok: 2500 },
  "anthropic/claude-opus-4-7":   { inputCentsPerMTok:  500, outputCentsPerMTok: 2500 },
  "anthropic/claude-sonnet-4-6": { inputCentsPerMTok:  300, outputCentsPerMTok: 1500 },
  "anthropic/claude-haiku-4-5":  { inputCentsPerMTok:  100, outputCentsPerMTok:  500 },
  "workers-ai/@cf/moonshotai/kimi-k2.6": { inputCentsPerMTok: 95, outputCentsPerMTok: 400 },
  // Title-upgrade model. Tiny pricing but logged for completeness so the
  // Settings page reflects every AI call.
  "workers-ai/@cf/meta/llama-3.2-1b-instruct": { inputCentsPerMTok: 2.7, outputCentsPerMTok: 20 },
};

// Cost in whole cents (legacy column). Rounds — sub-cent calls return 0.
export function estimateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  const cents =
    (inputTokens / 1_000_000) * p.inputCentsPerMTok +
    (outputTokens / 1_000_000) * p.outputCentsPerMTok;
  return Math.round(cents);
}

// Cost in micro-cents (1¢ = 1000 µ¢). Preserves precision for cheap calls
// like the title-upgrade — a $0.0002 call is 20 µ¢ instead of rounding to 0.
export function estimateCostMicroCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  const microCents =
    (inputTokens / 1_000_000) * p.inputCentsPerMTok * 1000 +
    (outputTokens / 1_000_000) * p.outputCentsPerMTok * 1000;
  return Math.round(microCents);
}

// Cache-aware usage breakdown for the native Anthropic path.
// inputTokens here is the UNCACHED remainder only (Anthropic's
// usage.input_tokens); cache reads bill at 0.1×, 5-minute-TTL cache
// writes at 1.25× base input.
export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function estimateCostMicroCentsDetailed(
  model: string,
  u: UsageBreakdown,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  const inRate = p.inputCentsPerMTok * 1000;
  const microCents =
    (u.inputTokens / 1_000_000) * inRate +
    ((u.cacheReadTokens ?? 0) / 1_000_000) * inRate * 0.1 +
    ((u.cacheWriteTokens ?? 0) / 1_000_000) * inRate * 1.25 +
    (u.outputTokens / 1_000_000) * p.outputCentsPerMTok * 1000;
  return Math.round(microCents);
}
