// Bring-your-own Anthropic key. The key is AES-GCM encrypted at rest with
// the same TOKEN_ENCRYPTION_KEY used for HubSpot OAuth tokens, with its own
// IV. Reads happen server-side only — the key never round-trips through
// Durable Object payloads or API responses (routes report `hasKey`, never
// the key itself).

import type { Env } from "../index";
import { encryptString, decryptString } from "./crypto";

export interface PortalChatConfig {
  apiKey: string | null;
  chatModel: string | null; // prefixed, e.g. "anthropic/claude-opus-4-8"
}

// Model families the Studio loop is known-good on: native Messages path,
// cache_control on tools, fine-grained tool streaming, >=32k output. The 3.x
// generation fails at least one of those, so it's filtered out of the picker.
const SUPPORTED_MODEL_PREFIXES = [
  "claude-fable",
  "claude-mythos",
  "claude-opus-4",
  "claude-sonnet-4",
  "claude-sonnet-5",
  "claude-haiku-4",
];

export function isSupportedAnthropicModel(id: string): boolean {
  return SUPPORTED_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

export async function getPortalChatConfig(
  env: Env,
  hubId: number,
): Promise<PortalChatConfig> {
  const row = await env.DB.prepare(
    `SELECT anthropic_key_enc, anthropic_key_iv, chat_model
       FROM installs WHERE hub_id = ?`,
  )
    .bind(hubId)
    .first<{
      anthropic_key_enc: ArrayBuffer | null;
      anthropic_key_iv: ArrayBuffer | null;
      chat_model: string | null;
    }>();
  if (!row?.anthropic_key_enc || !row.anthropic_key_iv) {
    return { apiKey: null, chatModel: null };
  }
  try {
    const apiKey = await decryptString(
      row.anthropic_key_enc,
      row.anthropic_key_iv,
      env.TOKEN_ENCRYPTION_KEY,
    );
    return { apiKey, chatModel: row.chat_model ?? null };
  } catch (err) {
    console.error("[byok] key decrypt failed for hub", hubId, err);
    return { apiKey: null, chatModel: null };
  }
}

export async function setPortalAnthropicKey(
  env: Env,
  hubId: number,
  apiKey: string,
): Promise<void> {
  const { ciphertext, iv } = await encryptString(apiKey, env.TOKEN_ENCRYPTION_KEY);
  await env.DB.prepare(
    `UPDATE installs
        SET anthropic_key_enc = ?, anthropic_key_iv = ?, updated_at = ?
      WHERE hub_id = ?`,
  )
    .bind(ciphertext, iv, Date.now(), hubId)
    .run();
}

export async function clearPortalAnthropicKey(
  env: Env,
  hubId: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE installs
        SET anthropic_key_enc = NULL, anthropic_key_iv = NULL,
            chat_model = NULL, updated_at = ?
      WHERE hub_id = ?`,
  )
    .bind(Date.now(), hubId)
    .run();
}

export async function setPortalChatModel(
  env: Env,
  hubId: number,
  chatModel: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE installs SET chat_model = ?, updated_at = ? WHERE hub_id = ?`,
  )
    .bind(chatModel, Date.now(), hubId)
    .run();
}

export interface AnthropicModelInfo {
  id: string;
  displayName: string;
}

// Lists models the key can access, filtered to the families Studio supports.
// Doubles as key validation: a bad key surfaces as { ok: false, status: 401 }.
// Hits api.anthropic.com directly (not the gateway) — it's a free metadata
// endpoint and we want the key's own view of available models.
export async function listAnthropicModels(
  apiKey: string,
): Promise<
  | { ok: true; models: AnthropicModelInfo[] }
  | { ok: false; status: number; error: string }
> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  }
  const body = (await res.json()) as {
    data?: Array<{ id: string; display_name?: string }>;
  };
  const models = (body.data ?? [])
    .filter((m) => isSupportedAnthropicModel(m.id))
    .map((m) => ({ id: m.id, displayName: m.display_name ?? m.id }));
  return { ok: true, models };
}
