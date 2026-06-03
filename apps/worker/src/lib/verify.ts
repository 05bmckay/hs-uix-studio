// Middleware that gates authenticated routes. Two paths:
//
//   1. Production: the request carries X-HubSpot-Signature-V3 and
//      X-HubSpot-Request-Timestamp. We HMAC-SHA256 verify the request
//      against env.HUBSPOT_CLIENT_SECRET per HubSpot's v3 spec, then
//      trust portal/user identity carried in the signed body.
//      Docs: https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests
//
//   2. Local dev (no signature header, WORKER_PUBLIC_URL contains
//      "localhost"): trust X-Studio-Hub-Id / X-Studio-User-Id dev headers
//      so curl and local wrangler work without signing.
//
// Any request with a signature header must pass verification — we don't
// silently fall through to the dev path when signing is malformed.

import type { Context } from "hono";
import type { Env } from "../index";
import { getFreshInstall, type HubspotTokenResponse } from "./auth";
import type { Install } from "./db";

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

// Per HubSpot v3 docs, these URL-encoded chars must be decoded when
// rebuilding the URI for signature computation.
const URI_DECODE_MAP: Record<string, string> = {
  "%3A": ":",
  "%2F": "/",
  "%3F": "?",
  "%40": "@",
  "%21": "!",
  "%24": "$",
  "%27": "'",
  "%28": "(",
  "%29": ")",
  "%2A": "*",
  "%2C": ",",
  "%3B": ";",
};

export interface Caller {
  hubId: number;
  userId: number;
  install: Install;
  // Parsed body — route handlers should use this instead of calling
  // c.req.json() a second time, since the body was consumed during verify.
  body: unknown;
}

export async function requireInstall(
  c: Context<{ Bindings: Env }>,
): Promise<Caller | Response> {
  const signatureHeader = c.req.header("x-hubspot-signature-v3");

  let hubId: number | null = null;
  let userId: number | null = null;
  let parsedBody: unknown = null;

  if (signatureHeader) {
    const verification = await verifyV3(c, signatureHeader);
    if (!verification.ok) {
      return jsonError(
        c,
        401,
        "bad_signature",
        verification.reason || "signature verification failed",
      );
    }
    parsedBody = verification.parsedBody;
    // Identity comes from the signed body (or HubSpot-supplied portal
    // headers where available). Since the signature covers the body,
    // body-sourced identity is trustworthy.
    // Identity is attached by HubSpot's hubspot.fetch — either as query
    // params (portalId/userId/appId/userEmail) on the signed URL, or as
    // headers/body fields on some flows. Check all three.
    const isLocal = c.env.WORKER_PUBLIC_URL.includes("localhost");
    hubId =
      numOrNull(c.req.query("portalId")) ??
      numOrNull(c.req.query("hubId")) ??
      numOrNull(c.req.header("x-hubspot-portal-id")) ??
      numOrNull(c.req.header("x-hubspot-hub-id")) ??
      extractFromBody(parsedBody, "hubId") ??
      extractFromBody(parsedBody, "portalId") ??
      (isLocal ? numOrNull(c.env.LOCAL_HUB_ID) : null);
    userId =
      numOrNull(c.req.query("userId")) ??
      numOrNull(c.req.header("x-hubspot-user-id")) ??
      extractFromBody(parsedBody, "userId") ??
      (isLocal ? numOrNull(c.env.LOCAL_USER_ID) : null) ??
      0; // userId is optional for most routes; fall back to 0 if absent.
  } else {
    // Dev-header path — only allowed when we're clearly not in prod.
    if (!c.env.WORKER_PUBLIC_URL.includes("localhost")) {
      return jsonError(
        c,
        401,
        "unauthenticated",
        "signature header required in production",
      );
    }
    hubId =
      numOrNull(c.req.header("x-studio-hub-id")) ??
      numOrNull(c.env.LOCAL_HUB_ID);
    userId =
      numOrNull(c.req.header("x-studio-user-id")) ??
      numOrNull(c.env.LOCAL_USER_ID) ??
      0;
  }

  if (hubId == null) {
    return jsonError(c, 401, "unauthenticated", "missing caller identity");
  }

  const isLocal = c.env.WORKER_PUBLIC_URL.includes("localhost");
  if (isLocal && c.env.LOCAL_DEV_AUTH_BYPASS === "true") {
    return {
      hubId,
      userId: userId ?? 0,
      install: {
        hubId,
        userId: userId ?? 0,
        scopes: c.env.HUBSPOT_APP_SCOPES,
        accessToken: "local-dev-access-token",
        refreshToken: "local-dev-refresh-token",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        creditMicroCents: 3_000_000,
      },
      body: parsedBody,
    };
  }

  const install = await getFreshInstall(c.env, hubId);
  if (!install) {
    return jsonError(c, 403, "not_installed", `no install for hub ${hubId}`);
  }
  return { hubId, userId: userId ?? 0, install, body: parsedBody };
}

interface V3Result {
  ok: boolean;
  reason?: string;
  parsedBody?: unknown;
}

async function verifyV3(
  c: Context<{ Bindings: Env }>,
  signature: string,
): Promise<V3Result> {
  const timestampHeader = c.req.header("x-hubspot-request-timestamp");
  if (!timestampHeader) return { ok: false, reason: "missing_timestamp" };
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  if (Date.now() - timestamp > SIGNATURE_MAX_AGE_MS) {
    return { ok: false, reason: "timestamp_expired" };
  }

  // Read body once as text. Subsequent route handlers receive it via Caller.body.
  const rawBody = await c.req.raw.clone().text();

  // Rebuild the URI, decoding the specific encoded chars HubSpot lists.
  const url = new URL(c.req.raw.url);
  const decodedPath = decodeUriChars(url.pathname);
  const decodedSearch = decodeUriChars(url.search);
  const uri = `${url.protocol}//${url.host}${decodedPath}${decodedSearch}`;

  const raw = `${c.req.raw.method}${uri}${rawBody}${timestampHeader}`;
  const expected = await hmacSha256Base64(
    c.env.HUBSPOT_CLIENT_SECRET,
    raw,
  );

  if (!constantTimeEqual(expected, signature)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  let parsedBody: unknown = null;
  if (rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      // Non-JSON body is acceptable on some routes — leave parsedBody null.
    }
  }
  return { ok: true, parsedBody };
}

async function hmacSha256Base64(
  secret: string,
  data: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return bytesToBase64(new Uint8Array(sig));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Constant-time string compare. Diff short-circuits would leak length/bytes
// via timing. We zero-pad to the longer length so iteration count is fixed.
function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function decodeUriChars(s: string): string {
  let out = s;
  for (const [encoded, decoded] of Object.entries(URI_DECODE_MAP)) {
    // Global replace, case-insensitive on the percent-encoded hex digits.
    out = out.replace(new RegExp(encoded, "gi"), decoded);
  }
  return out;
}

function extractFromBody(body: unknown, key: string): number | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function numOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function jsonError(
  c: Context,
  status: number,
  code: string,
  message: string,
): Response {
  return c.json({ error: code, message }, status as 400 | 401 | 403 | 501);
}

export type { HubspotTokenResponse };
