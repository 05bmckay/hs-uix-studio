// OpenAI client wired through Cloudflare's AI Gateway Unified endpoint. One
// OpenAI-shaped interface; the backend is chosen by the `model` string's
// prefix (e.g. "anthropic/claude-sonnet-4-6", "workers-ai/@cf/moonshotai/kimi-k2.6").
//
// Docs: https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
//
// Why unified instead of native Anthropic:
//   - Swapping models is a string change, not a tool-loop rewrite.
//   - Tradeoff: we lose Anthropic's explicit prompt-caching markers
//     (cache_control blocks). OpenAI-compat passes only a subset of
//     provider-specific fields, and Anthropic caching requires the markers.
//     OpenAI and Workers AI (Kimi) do automatic prompt caching at the
//     platform level, so those backends still cache without help.

import OpenAI from "openai";
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

// Pricing per 1M tokens (USD cents). Keys match the prefixed model string
// passed to chat.completions.create. Update when pricing changes.
const PRICING: Record<string, { inputCentsPerMTok: number; outputCentsPerMTok: number }> = {
  "anthropic/claude-opus-4-7":   { inputCentsPerMTok: 1500, outputCentsPerMTok: 7500 },
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
