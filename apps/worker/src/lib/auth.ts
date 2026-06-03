// HubSpot OAuth token exchange, refresh, and request verification.
// See: https://developers.hubspot.com/docs/apps/legacy-apps/authentication/oauth-quickstart-guide
//
// Internal async/error flow uses Effect for typed errors and composition.
// Exported functions remain Promise-based so route handlers are unaffected.

import { Data, Effect } from "effect";
import type { Env } from "../index";
import {
  DbCryptoError,
  DbQueryError,
  getInstallEffect,
  upsertInstallEffect,
  type Install,
} from "./db";

// Tagged errors — distinct types for the Effect error channel

export class TokenExchangeError extends Data.TaggedError("TokenExchangeError")<{
  readonly status: number;
  readonly body: string;
}> {}

export class TokenRefreshError extends Data.TaggedError("TokenRefreshError")<{
  readonly status: number;
  readonly body: string;
}> {}

export class TokenIntrospectError extends Data.TaggedError("TokenIntrospectError")<{
  readonly status: number;
}> {}

const TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const TOKEN_INFO_URL = "https://api.hubapi.com/oauth/v1/access-tokens";

export interface HubspotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: "bearer";
}

export interface AccessTokenMeta {
  hub_id: number;
  user_id: number;
  scopes: string[];
  token: string;
}

function dbErrorToError(error: DbQueryError | DbCryptoError): Error {
  const prefix = error._tag === "DbQueryError" ? "DB" : "crypto";
  const message = error.cause instanceof Error ? error.cause.message : String(error.cause);
  return new Error(`${prefix} ${error.operation} failed: ${message}`);
}

export function buildInstallRedirect(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.HUBSPOT_CLIENT_ID,
    redirect_uri: `${env.WORKER_PUBLIC_URL}/oauth/callback`,
    scope: env.HUBSPOT_APP_SCOPES,
    state,
  });
  return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
}

// Internal Effect programs

const exchangeCodeForTokensEffect = (env: Env, code: string) =>
  Effect.gen(function* () {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.HUBSPOT_CLIENT_ID,
      client_secret: env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: `${env.WORKER_PUBLIC_URL}/oauth/callback`,
      code,
    });
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        }),
      catch: (cause) =>
        new TokenExchangeError({
          status: 0,
          body: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    if (!res.ok) {
      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (cause) =>
          new TokenExchangeError({
            status: res.status,
            body: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      yield* Effect.fail(new TokenExchangeError({ status: res.status, body: text }));
    }
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<HubspotTokenResponse>,
      catch: (cause) =>
        new TokenExchangeError({
          status: res.status,
          body: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  });

const refreshAccessTokenEffect = (env: Env, refreshToken: string) =>
  Effect.gen(function* () {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.HUBSPOT_CLIENT_ID,
      client_secret: env.HUBSPOT_CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        }),
      catch: (cause) =>
        new TokenRefreshError({
          status: 0,
          body: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    if (!res.ok) {
      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (cause) =>
          new TokenRefreshError({
            status: res.status,
            body: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      yield* Effect.fail(new TokenRefreshError({ status: res.status, body: text }));
    }
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<HubspotTokenResponse>,
      catch: (cause) =>
        new TokenRefreshError({
          status: res.status,
          body: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  });

const introspectAccessTokenEffect = (token: string) =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(`${TOKEN_INFO_URL}/${token}`),
      catch: () => new TokenIntrospectError({ status: 0 }),
    });
    if (!res.ok) {
      yield* Effect.fail(new TokenIntrospectError({ status: res.status }));
    }
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<AccessTokenMeta>,
      catch: () => new TokenIntrospectError({ status: res.status }),
    });
  });

const REFRESH_WINDOW_MS = 5 * 60 * 1000;

const getFreshInstallEffect = (env: Env, hubId: number) =>
  Effect.gen(function* () {
    const install = yield* getInstallEffect(env, hubId);
    if (!install) return null;
    if (install.expiresAt - Date.now() > REFRESH_WINDOW_MS) return install;

    const refreshed = yield* refreshAccessTokenEffect(env, install.refreshToken);
    const updated: Install = {
      ...install,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    };
    yield* upsertInstallEffect(env, updated);
    return updated;
  });

// Promise-based exports — bridge Effect to async/await, mapping tagged
// errors to thrown Errors to preserve original runtime behavior.

export async function exchangeCodeForTokens(
  env: Env,
  code: string,
): Promise<HubspotTokenResponse> {
  return Effect.runPromise(
    exchangeCodeForTokensEffect(env, code).pipe(
      Effect.catchTags({
        TokenExchangeError: (e) =>
          Effect.fail(new Error(`HubSpot token exchange failed: ${e.status} ${e.body}`)),
      }),
    ),
  );
}

export async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<HubspotTokenResponse> {
  return Effect.runPromise(
    refreshAccessTokenEffect(env, refreshToken).pipe(
      Effect.catchTags({
        TokenRefreshError: (e) =>
          Effect.fail(new Error(`HubSpot refresh failed: ${e.status} ${e.body}`)),
      }),
    ),
  );
}

export async function introspectAccessToken(
  token: string,
): Promise<AccessTokenMeta> {
  return Effect.runPromise(
    introspectAccessTokenEffect(token).pipe(
      Effect.catchTags({
        TokenIntrospectError: (e) =>
          Effect.fail(new Error(`HubSpot token introspect failed: ${e.status}`)),
      }),
    ),
  );
}

export async function getFreshInstall(
  env: Env,
  hubId: number,
): Promise<Install | null> {
  return Effect.runPromise(
    getFreshInstallEffect(env, hubId).pipe(
      Effect.catchTags({
        TokenRefreshError: (e) =>
          Effect.fail(new Error(`HubSpot refresh failed: ${e.status} ${e.body}`)),
        DbQueryError: (e) => Effect.fail(dbErrorToError(e)),
        DbCryptoError: (e) => Effect.fail(dbErrorToError(e)),
      }),
    ),
  );
}
