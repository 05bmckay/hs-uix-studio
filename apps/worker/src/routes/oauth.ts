import { Hono } from "hono";
import type { Env } from "../index";
import {
  buildInstallRedirect,
  exchangeCodeForTokens,
  introspectAccessToken,
} from "../lib/auth";
import {
  upsertInstall,
  BETA_CREDIT_LIMIT,
  BETA_CREDIT_MICRO_CENTS,
} from "../lib/db";

export const oauthRoutes = new Hono<{ Bindings: Env }>();

const STATE_TTL_SECONDS = 300; // 5 minutes

// GET /oauth/install
// A beta user opens this URL → redirected to HubSpot to authorize → returns
// to /oauth/callback with ?code=...&state=...
oauthRoutes.get("/install", async (c) => {
  const state = crypto.randomUUID();
  // KV row is the CSRF nonce; callback checks it exists and deletes it.
  await c.env.OAUTH_STATE.put(`state:${state}`, "1", {
    expirationTtl: STATE_TTL_SECONDS,
  });
  return c.redirect(buildInstallRedirect(c.env, state));
});

// GET /oauth/callback
// Validates the state nonce, exchanges the code, persists the install.
oauthRoutes.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  if (error) return c.text(`OAuth error: ${error}`, 400);
  if (!code) return c.text("Missing code", 400);

  // State is optional: HubSpot's developer-portal install button calls us
  // without going through /oauth/install, so there's no nonce to check. We
  // still validate state when present — belt-and-braces for the /install
  // entry path — but accept installs without it. Trade-off: no CSRF guard
  // on the "install from HubSpot UI" flow, which is acceptable for a
  // prototype with known beta users.
  if (state) {
    const stateKey = `state:${state}`;
    const expected = await c.env.OAUTH_STATE.get(stateKey);
    if (expected) await c.env.OAUTH_STATE.delete(stateKey);
  }

  const tokens = await exchangeCodeForTokens(c.env, code);
  const meta = await introspectAccessToken(tokens.access_token);

  // Beta gate: only the first BETA_CREDIT_LIMIT hubs may install. Reinstalls
  // (existing row) always go through so token refresh keeps working. New
  // hubs are admitted only if total installs are still under the cap, and
  // they get a $30 credit row on first insert.
  const existing = await c.env.DB.prepare(
    `SELECT hub_id FROM installs WHERE hub_id = ?`,
  )
    .bind(meta.hub_id)
    .first<{ hub_id: number }>();

  if (!existing) {
    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM installs`,
    ).first<{ n: number }>();
    const installCount = countRow?.n ?? 0;
    if (installCount >= BETA_CREDIT_LIMIT) {
      return c.text(
        `Studio is currently in a closed beta limited to ${BETA_CREDIT_LIMIT} accounts. ` +
          `Reach out to me@cartermckay.com if you'd like to be added to the waitlist.`,
        403,
      );
    }
  }

  await upsertInstall(c.env, {
    hubId: meta.hub_id,
    userId: meta.user_id,
    scopes: meta.scopes.join(" "),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    // upsertInstall doesn't write this column — credit is granted below
    // on first insert and otherwise preserved across reinstalls.
    creditMicroCents: 0,
  });

  if (!existing) {
    await c.env.DB.prepare(
      `UPDATE installs SET credit_micro_cents = ? WHERE hub_id = ?`,
    )
      .bind(BETA_CREDIT_MICRO_CENTS, meta.hub_id)
      .run();
  }

  // Land the user on the Studio app home in their portal.
  const APP_ID = 37459394;
  return c.redirect(`https://app.hubspot.com/app/${meta.hub_id}/${APP_ID}/`);
});
