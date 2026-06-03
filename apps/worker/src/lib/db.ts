// Thin D1 helpers. Keep prepared-statement usage explicit at call sites —
// D1 is fast enough that we don't need an ORM, and the mental overhead of one
// isn't worth it for a worker this size.

import { Data, Effect } from "effect";
import type { Env } from "../index";
import { encryptString, decryptString } from "./crypto";

export class DbQueryError extends Data.TaggedError("DbQueryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class DbCryptoError extends Data.TaggedError("DbCryptoError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface Install {
  hubId: number;
  userId: number;
  scopes: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  creditMicroCents: number; // beta budget; 0 = no allowance
}

export const BETA_CREDIT_LIMIT = 10;
export const BETA_CREDIT_MICRO_CENTS = 3_000_000; // $30

// Returns spend in micro-cents so it can be compared directly against
// install.creditMicroCents.
export async function getHubSpendMicroCents(
  env: Env,
  hubId: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(
              SUM(COALESCE(estimated_cost_micro_cents, estimated_cost_cents * 1000)),
              0
            ) AS spend
       FROM usage_events WHERE hub_id = ?`,
  )
    .bind(hubId)
    .first<{ spend: number }>();
  return row?.spend ?? 0;
}

function errorMessageFromCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toPlainError(error: DbQueryError | DbCryptoError): Error {
  const prefix = error._tag === "DbQueryError" ? "DB" : "crypto";
  return new Error(`${prefix} ${error.operation} failed: ${errorMessageFromCause(error.cause)}`);
}

export const upsertInstallEffect = (env: Env, install: Install) =>
  Effect.gen(function* () {
    const { ciphertext: accessCt, iv } = yield* Effect.tryPromise({
      try: () => encryptString(install.accessToken, env.TOKEN_ENCRYPTION_KEY),
      catch: (cause) =>
        new DbCryptoError({ operation: "encrypt access token", cause }),
    });
    const { ciphertext: refreshCt } = yield* Effect.tryPromise({
      try: () =>
        encryptString(
          install.refreshToken,
          env.TOKEN_ENCRYPTION_KEY,
          new Uint8Array(iv),
        ),
      catch: (cause) =>
        new DbCryptoError({ operation: "encrypt refresh token", cause }),
    });
    const now = Date.now();
    yield* Effect.tryPromise({
      try: () =>
        env.DB.prepare(
          `INSERT INTO installs
             (hub_id, user_id, scopes, access_token_enc, refresh_token_enc, token_iv,
              expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hub_id) DO UPDATE SET
             user_id           = excluded.user_id,
             scopes            = excluded.scopes,
             access_token_enc  = excluded.access_token_enc,
             refresh_token_enc = excluded.refresh_token_enc,
             token_iv          = excluded.token_iv,
             expires_at        = excluded.expires_at,
             updated_at        = excluded.updated_at`,
        )
          .bind(
            install.hubId,
            install.userId,
            install.scopes,
            new Uint8Array(accessCt),
            new Uint8Array(refreshCt),
            iv,
            install.expiresAt,
            now,
            now,
          )
          .run(),
      catch: (cause) => new DbQueryError({ operation: "upsert install", cause }),
    });
  });

export const getInstallEffect = (env: Env, hubId: number) =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () =>
        env.DB.prepare(
          `SELECT hub_id, user_id, scopes, access_token_enc, refresh_token_enc,
                  token_iv, expires_at, credit_micro_cents
             FROM installs WHERE hub_id = ?`,
        )
          .bind(hubId)
          .first<{
            hub_id: number;
            user_id: number;
            scopes: string;
            access_token_enc: ArrayBuffer;
            refresh_token_enc: ArrayBuffer;
            token_iv: ArrayBuffer;
            expires_at: number;
            credit_micro_cents: number;
          }>(),
      catch: (cause) => new DbQueryError({ operation: "get install", cause }),
    });
    if (!row) return null;

    const accessToken = yield* Effect.tryPromise({
      try: () =>
        decryptString(
          row.access_token_enc,
          row.token_iv,
          env.TOKEN_ENCRYPTION_KEY,
        ),
      catch: (cause) =>
        new DbCryptoError({ operation: "decrypt access token", cause }),
    });
    const refreshToken = yield* Effect.tryPromise({
      try: () =>
        decryptString(
          row.refresh_token_enc,
          row.token_iv,
          env.TOKEN_ENCRYPTION_KEY,
        ),
      catch: (cause) =>
        new DbCryptoError({ operation: "decrypt refresh token", cause }),
    });

    return {
      hubId: row.hub_id,
      userId: row.user_id,
      scopes: row.scopes,
      accessToken,
      refreshToken,
      expiresAt: row.expires_at,
      creditMicroCents: row.credit_micro_cents ?? 0,
    };
  });

export const logUsageEffect = (
  env: Env,
  row: {
    id: string;
    hubId: number;
    chatId: string;
    messageId: string;
    // Optional. Set when the call originates outside a chat turn (export,
    // title-upgrade) so per-project aggregates can attribute it without a
    // `chats` row to join through.
    projectId?: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostCents: number;
    // Sub-cent precision (1¢ = 1000 µ¢). New writers should pass this so
    // cheap calls like the chat-title upgrade don't round to 0.
    estimatedCostMicroCents?: number;
  },
 ) =>
  Effect.tryPromise({
    try: () =>
      env.DB.prepare(
        `INSERT INTO usage_events
           (id, hub_id, chat_id, message_id, project_id, model,
            input_tokens, output_tokens,
            estimated_cost_cents, estimated_cost_micro_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
     )
        .bind(
          row.id,
          row.hubId,
          row.chatId,
          row.messageId,
          row.projectId ?? null,
          row.model,
          row.inputTokens,
          row.outputTokens,
          row.estimatedCostCents,
          row.estimatedCostMicroCents ?? row.estimatedCostCents * 1000,
          Date.now(),
        )
        .run(),
    catch: (cause) => new DbQueryError({ operation: "log usage", cause }),
  }).pipe(Effect.asVoid);

export async function upsertInstall(env: Env, install: Install): Promise<void> {
  return Effect.runPromise(
    upsertInstallEffect(env, install).pipe(
      Effect.catchTags({
        DbQueryError: (error) => Effect.fail(toPlainError(error)),
        DbCryptoError: (error) => Effect.fail(toPlainError(error)),
      }),
    ),
  );
}

export async function getInstall(
  env: Env,
  hubId: number,
): Promise<Install | null> {
  return Effect.runPromise(
    getInstallEffect(env, hubId).pipe(
      Effect.catchTags({
        DbQueryError: (error) => Effect.fail(toPlainError(error)),
        DbCryptoError: (error) => Effect.fail(toPlainError(error)),
      }),
    ),
  );
}

export async function logUsage(
  env: Env,
  row: {
    id: string;
    hubId: number;
    chatId: string;
    messageId: string;
    projectId?: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostCents: number;
    estimatedCostMicroCents?: number;
  },
): Promise<void> {
  return Effect.runPromise(
    logUsageEffect(env, row).pipe(
      Effect.catchTags({
        DbQueryError: (error) => Effect.fail(toPlainError(error)),
      }),
    ),
  );
}
