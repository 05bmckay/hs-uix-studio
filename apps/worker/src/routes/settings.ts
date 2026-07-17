// Portal settings — bring-your-own Anthropic key + model choice.
//
//   GET    /settings/anthropic  → { hasKey, chatModel, models[] }
//          (models fetched live with the stored key; empty when no key)
//   POST   /settings/anthropic  { key }  → validates against the Anthropic
//          models endpoint (bad key = 400), stores encrypted, returns models
//   PUT    /settings/anthropic/model { model } → pin a model the key can use
//          (bare or prefixed id; null/"" resets to server default)
//   DELETE /settings/anthropic  → clears key + model choice
//
// The key is never returned by any route.

import { Hono } from "hono";
import type { Env } from "../index";
import { requireInstall } from "../lib/verify";
import {
  getPortalChatConfig,
  setPortalAnthropicKey,
  clearPortalAnthropicKey,
  setPortalChatModel,
  listAnthropicModels,
  isSupportedAnthropicModel,
} from "../lib/byok";

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.get("/anthropic", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const config = await getPortalChatConfig(c.env, caller.hubId);
  if (!config.apiKey) {
    return c.json({ hasKey: false, chatModel: null, models: [] });
  }
  const listed = await listAnthropicModels(config.apiKey);
  return c.json({
    hasKey: true,
    chatModel: config.chatModel,
    // A key that stopped working shows up as an empty model list plus
    // keyError so the UI can prompt for a replacement.
    models: listed.ok ? listed.models : [],
    ...(listed.ok ? {} : { keyError: `key check failed (${listed.status})` }),
  });
});

settingsRoutes.post("/anthropic", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const body = ((caller.body as { key?: string } | null) ??
    (await c.req.json().catch(() => null))) as { key?: string } | null;
  const key = body?.key?.trim();
  if (!key || !key.startsWith("sk-ant-")) {
    return c.json(
      { error: "invalid_key", message: "Expected an Anthropic API key (sk-ant-…)." },
      400,
    );
  }

  const listed = await listAnthropicModels(key);
  if (!listed.ok) {
    const message =
      listed.status === 401
        ? "Anthropic rejected this key (401). Check it and try again."
        : `Couldn't verify the key with Anthropic (${listed.status}).`;
    return c.json({ error: "key_rejected", message }, 400);
  }

  await setPortalAnthropicKey(c.env, caller.hubId, key);
  return c.json({ hasKey: true, models: listed.models });
});

settingsRoutes.put("/anthropic/model", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const body = ((caller.body as { model?: string | null } | null) ??
    (await c.req.json().catch(() => null))) as { model?: string | null } | null;
  const raw = body?.model ?? null;

  if (raw == null || raw === "") {
    await setPortalChatModel(c.env, caller.hubId, null);
    return c.json({ chatModel: null });
  }

  const bare = raw.startsWith("anthropic/") ? raw.slice("anthropic/".length) : raw;
  if (!isSupportedAnthropicModel(bare)) {
    return c.json(
      { error: "unsupported_model", message: `Studio doesn't support "${bare}".` },
      400,
    );
  }
  const config = await getPortalChatConfig(c.env, caller.hubId);
  if (!config.apiKey) {
    return c.json(
      { error: "no_key", message: "Add an Anthropic API key first." },
      400,
    );
  }
  const listed = await listAnthropicModels(config.apiKey);
  if (listed.ok && !listed.models.some((m) => m.id === bare)) {
    return c.json(
      { error: "model_not_available", message: `Your key can't access "${bare}".` },
      400,
    );
  }

  const prefixed = `anthropic/${bare}`;
  await setPortalChatModel(c.env, caller.hubId, prefixed);
  return c.json({ chatModel: prefixed });
});

settingsRoutes.delete("/anthropic", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;
  await clearPortalAnthropicKey(c.env, caller.hubId);
  return c.json({ hasKey: false, chatModel: null });
});
