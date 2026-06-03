# Studio Settings & Usage — design brief

A single page inside the hs-uix Studio app that combines account management and usage analytics for the connected HubSpot portal. Rendered as an app page (not a CRM card), reachable from the app's top-level navigation.

## Why this page exists

Studio is multi-tenant per HubSpot portal and spends real Anthropic tokens on every chat turn. Today there's no surface that answers:

- Who installed this, with what scopes, and is the connection healthy?
- How much are we spending, and on what?
- Which projects / teammates are driving that spend?
- Is the assistant working well (tool success rates, turn latency), or is it thrashing?
- How do I disconnect or reauthorize?

One page, four tabs, all data already exists in D1 — we just need to expose and aggregate it.

## Data sources

Everything here is derivable from tables that already exist in `apps/worker/schema.sql`:

| Surface | Source |
|---|---|
| Portal, user, scopes, token expiry | `installs` |
| Project list + owners | `projects` (join `owner_user_id`) |
| Chats, messages counts | `chats`, `messages` |
| Token & cost totals | `usage_events` (sum `input_tokens`, `output_tokens`, `estimated_cost_cents`) |
| Tool call stats | `tool_calls` (group by `tool_name`, rate of `ok=false`) |
| Turn latency, success | `stream_events` (diff timestamps between `run_start` and `run_done`) |
| Recent activity feed | `usage_events` + `stream_events` + `tool_calls` joined and ordered by `created_at desc` |

**Needs a new endpoint:** `GET /usage` that aggregates the above, scoped to the caller's `hub_id`. Window parameter: `?window=7d|30d|all`. Return shape should match the page's sections so the client doesn't reshape.

**HubSpot for display names:** `installs` only stores `user_id` (numeric). Need a second fetch to HubSpot's user API (or cache on login) to render `carter@acme.com` rather than `50012345`. Fall back to "User #50012345" if unknown.

## Layout

```
┌──────────────────────────────────────────────────────────┐
│  Studio settings & usage                                 │
│  Manage your HubSpot connection and see how the Studio   │
│  assistant is spending tokens for this portal.           │
├──────────────────────────────────────────────────────────┤
│  [Overview]  [Usage]  [Team]  [Activity]  [Account]      │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                  (selected tab body)                     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Uncontrolled `Tabs` with `defaultSelected="overview"`. Tabs cache inactive children by default in the HubSpot SDK, so if any tab loads async data it should remount via a `key` bump when that data arrives (known gotcha).

## Tab 1 — Overview

Purpose: in five seconds, know whether this install is healthy and how busy it's been.

1. **Connected portal tile** — portal name, `Hub ID 12345678 · authorizing-user@x.com`, "Installed 10 weeks ago". Trailing status Tag: "Connection Active" (success) / "Reauthorize needed" (error).
2. **Four stat tiles** (AutoGrid, min 200px):
   - Projects — total, sublabel "2 created this month"
   - Chats — total, sublabel "12 in the last 7 days"
   - Tokens (30d) — "1.24M", sublabel "872K in · 368K out"
   - Spend (30d) — "$4.83", sublabel "Est. Anthropic cost"
3. **Last activity Alert** (info) — "Last chat · 42 minutes ago · Restaurant inventory card". Clickable, deep-links to the project.

### User flow
- Admin opens page → lands here → sees everything is green → closes.
- If status tag is red, clicking it jumps to Account tab.

## Tab 2 — Usage

Purpose: understand spend and where it's going.

1. **Window toggle** (top right): Last 7 days / Last 30 days / All time. `ToggleGroup`, uncontrolled, `defaultSelected="30d"`. Changing window refetches `/usage?window=`.
2. **Four headline stat tiles**: input tokens, output tokens, total cost, avg turn latency (with P95 sublabel).
3. **Daily token volume LineChart** — category `Day`, value `Tokens`, grouped by `Series` (Input vs Output). Bucket by day from `usage_events.created_at`.
4. **Usage by project DataTable**:
   | Project | Owner | Chats | Msgs | Tokens | Cost | Per turn | Δ vs prev. | Top tool | Last active |
   - `Δ vs prev.` is a colored `Tag` — green for negative change, red for large positive, blue for "new". Compare current window to immediately preceding equal-length window.
   - `Top tool` shows dominant tool + its share of total tool calls. Proxy for "what is this project mostly doing" — projects leaning on `validate_spec` are often thrashing.
   - `Per turn` = project cost ÷ count of successful `run_done` events for the project.

### User flow
- "We got a bill alert — where's the money going?" → Usage tab → headline stats confirm → scan project table for `Δ vs prev.` red tags → click into offender.
- "Last week was a quiet week" → toggle to 7d → numbers smaller → confirmed.

## Tab 3 — Team

Purpose: for portals with multiple teammates, show who's using Studio and how.

1. **Three stat tiles** — Active teammates (of seat count), Busiest user, Most projects.
2. **Horizontal BarChart** — token spend by user, last 30 days. One bar per user, sorted desc.
3. **Leaderboard DataTable**:
   | User | Role | Projects | Chats | Msgs | Tokens | Cost | Share % | Last active |
   - Role is a `Tag`. `Share %` = user's tokens / portal total.
4. **Who touches what matrix** — DataTable of (user, project, role, messages, tokens). One row per user × project pair with non-zero activity. Today every project has exactly one owner in `projects.owner_user_id`, so initially this is just a restatement; once we add shared projects it becomes more interesting.

### User flow
- Admin: "Priya is new, is she ramping up?" → Team tab → scan leaderboard → see her share at 37% with 17 chats → satisfied.
- Admin: "Who's running up spend?" → sort leaderboard by cost desc.

### Edge cases
- Single-user portal: Team tab still loads but leaderboard has one row and the matrix is trivial. Consider hiding the tab entirely when `activeTeammates === 1`.
- Departed user: show the row with a muted Tag ("No longer in portal") if HubSpot returns 404 on the user lookup. Don't delete their historical rows from `usage_events`.

## Tab 4 — Activity

Purpose: assistant health and a recent-events feed.

1. **Tool call stats DataTable** (30-day window):
   | Tool | Calls | Success rate | Avg latency |
   - Success rate rendered as a `Tag` — green ≥ 99%, yellow 95–99%, red below.
   - Sourced from `tool_calls` grouped by `tool_name`, with `ok=true` count over total.
2. **Recent events tile** — vertical list of the last ~20 events across `usage_events`, `stream_events.event='run_error'`, and `tool_calls` with `ok=false`. Each row: colored time Tag + project name + one-line summary.
   - Success: "Chat turn complete · 12.4K tokens · $0.04"
   - Warning: "validate_spec returned 2 warnings"
   - Error: "Chat turn errored · model overloaded"

### User flow
- Something feels broken → Activity tab → scan for red tags in events feed → see "model overloaded" three times in the last hour → know it's upstream, not us.
- Engineering curiosity: which tools does the assistant actually use? Table answers immediately.

## Tab 5 — Account

Purpose: boring but critical — connection controls.

1. **OAuth scopes tile** — heading, microcopy ("These are the HubSpot permissions this portal authorized when installing Studio"), then scopes as wrapped default `Tag`s. Source: `installs.scopes` split on space.
2. **Access token tile** — heading "Access token", microcopy "Refreshes automatically in 23 minutes" (computed from `installs.expires_at`). Trailing `Tag`: "Active" / "Refreshing" / "Expired".
3. **About tile** — "hs-uix Studio · v0.3.1" + "Worker deployed Apr 22, 2026" (read from a `/meta` worker endpoint returning `WORKER_GIT_SHA` / deploy time).
4. **Danger zone tile** — heading "Danger zone", explainer ("Disconnecting removes the stored OAuth tokens. Your projects, chats, and specs stay in place and will reappear after reinstalling."), two buttons:
   - `secondary` — **Reauthorize HubSpot** → kicks off `/oauth/install` again
   - `destructive` — **Disconnect portal** → confirm Modal → `DELETE /installs/me` → drops the install row (cascades... or doesn't — see below)

### User flow
- "I need to add a scope" → Account → Reauthorize → HubSpot consent screen → back here → new scope Tag appears.
- "We're offboarding this portal" → Danger zone → Disconnect → confirm → redirected to a simple "Disconnected" screen with a reinstall link.

### Open questions
- **Cascade on disconnect?** Today `installs` has FK relationships with `projects` (and transitively specs/chats/messages/usage_events). Decision needed: soft-disconnect (null the tokens, keep data so reinstall restores everything) vs hard-delete. Recommend soft: that's what the explainer promises.
- **Who can disconnect?** Only the original authorizing user, or any user on the portal? HubSpot's app-auth model means anyone who can see the page could click it. At minimum, gate behind a typed-confirmation Modal ("Type DISCONNECT to confirm").

## State & interactivity

The renderer's `state` is controlled by the parent; treat it as form state, not server state. Only two things are actually interactive state:

- `activeTab` — uncontrolled via `defaultSelected`. Not in `state`.
- `usageWindow` — `ToggleGroup`, uncontrolled. Changing it should trigger a parent-level refetch of `/usage?window=...` which re-renders the Usage tab's `data.*` fields. The spec itself doesn't conditionally render anything based on `usageWindow`.

No `$if` chains for display text. Every formatted label — `"872K"`, `"$0.04"`, `"42 min ago"`, `"+38%"`, variant tags — lives pre-computed in `data`. The worker does that formatting, which keeps the spec narrow and makes the rendered card identical to a real production card.

## Empty and error states

- **Fresh install, no usage yet** — all four Overview stat tiles show `0` / `—`, Usage tab shows an `EmptyState` ("No chats yet — start a project to see usage here"), Activity events feed shows "No events yet".
- **`/usage` endpoint fails** — page still renders Account and Overview from `installs` cache; Usage/Team/Activity tabs show an `Alert` variant="error" with a retry button.
- **Token expired** — top of every tab shows a persistent `Alert` variant="warning" with a reauthorize CTA. The Account tab's token tile mirrors the same state.

## Component inventory

All from hs-uix or `@hubspot/ui-extensions`:

- Layout: `Flex`, `Box`, `AutoGrid`, `Tile`, `Divider`
- Typography: `Heading`, `Text`
- Navigation: `Tabs` / `Tab`, `ToggleGroup` / `Toggle`
- Data: `DataTable` (with `render` cell overrides), `LineChart`, `BarChart`
- Status: `Tag`, `Alert`, `EmptyState`, `LoadingSpinner`
- Actions: `Button`, `Modal` (for disconnect confirmation)

Known caveats to respect when designing:
- Use uncontrolled Tabs/ToggleGroup with `defaultSelected` — the renderer has no `$event` binding.
- If any tab depends on async-loaded data, force a remount via `key` when that data arrives.
- In DataTable, `width` sizes header + cell-fallback; `cellWidth: "min"` stops cell wrapping.
