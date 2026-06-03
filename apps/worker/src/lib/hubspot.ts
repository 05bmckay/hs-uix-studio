// Thin HubSpot REST helpers used outside the OAuth flow. Auth/refresh lives
// in lib/auth.ts; this file just makes outbound API calls with a fresh token.

import type { Install } from "./db";

const CRM_USERS_LIST = "https://api.hubapi.com/crm/v3/objects/users";

export interface HubspotUser {
  id: number; // HubSpot login user ID (matches OAuth user_id)
  name: string | null;
  email: string | null;
}

interface ListResponse {
  results?: Array<{
    id: string;
    properties?: {
      hs_email?: string;
      hs_given_name?: string;
      hs_family_name?: string;
      hs_internal_user_id?: string;
    };
  }>;
  paging?: { next?: { after?: string } };
}

export interface UserLookupDebug {
  scopes: string;
  pages: number;
  attempts: Array<{
    status: number;
    bodyPreview: string;
    mapped: number;
  }>;
}

// List all CRM `users` records in the portal and key them by
// `hs_internal_user_id` — the same value as the OAuth `user_id` we store on
// projects/installs. Requires the `crm.objects.users.read` scope; on 403 (or
// any non-OK response) we return what we have so far so the UI degrades
// gracefully to `User #<id>`.
//
// Reading the whole list is fine: the `users` object is portal staff (tens
// to low hundreds), not contacts. One paginated GET is simpler than
// per-request batch lookups and gives us a hub-wide directory we can reuse.
export async function fetchAllUsers(
  install: Install,
  debug?: UserLookupDebug,
): Promise<Map<number, HubspotUser>> {
  const result = new Map<number, HubspotUser>();
  if (debug) debug.scopes = install.scopes;

  let after: string | undefined;
  let page = 0;
  // Cap pages defensively — 10 pages × 100/page = 1000 users, well above any
  // realistic portal user count and keeps a misconfigured cursor from looping.
  while (page < 10) {
    page += 1;
    const url = new URL(CRM_USERS_LIST);
    url.searchParams.set("limit", "100");
    url.searchParams.set(
      "properties",
      "hs_email,hs_given_name,hs_family_name,hs_internal_user_id",
    );
    if (after) url.searchParams.set("after", after);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${install.accessToken}` },
    });
    const rawText = await res.text();
    console.log(
      `[hubspot.fetchAllUsers] page=${page} status=${res.status} body=${rawText.slice(0, 400)}`,
    );

    const before = result.size;
    if (debug) {
      debug.pages = page;
      debug.attempts.push({
        status: res.status,
        bodyPreview: rawText.slice(0, 400),
        mapped: 0,
      });
    }

    if (!res.ok) return result;

    let json: ListResponse;
    try {
      json = JSON.parse(rawText) as ListResponse;
    } catch (err) {
      console.warn(`[hubspot.fetchAllUsers] invalid JSON: ${err}`);
      return result;
    }

    for (const row of json.results ?? []) {
      const p = row.properties ?? {};
      const internalId = Number(p.hs_internal_user_id);
      if (!Number.isFinite(internalId)) continue;
      const name =
        [p.hs_given_name, p.hs_family_name].filter(Boolean).join(" ").trim() ||
        null;
      result.set(internalId, {
        id: internalId,
        name,
        email: p.hs_email || null,
      });
    }

    if (debug && debug.attempts.length > 0) {
      debug.attempts[debug.attempts.length - 1].mapped = result.size - before;
    }

    after = json.paging?.next?.after;
    if (!after) break;
  }

  return result;
}
