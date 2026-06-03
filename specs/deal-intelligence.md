# Deal Intelligence

Deal Intelligence is a three-tab CRM record card for account executives working deals in HubSpot. It surfaces deal health, interaction history, and competitive positioning in a single card on the deal record tab, eliminating the need to switch between tools or external documents during active selling.

## Context

- **Surface:** `crm.record.tab` — a full-width tab rendered on the HubSpot deal record page, giving more horizontal space than a sidebar card and supporting richer layouts like grids and tables.
- **Object:** `deal`
- **Audience / primary user:** Account executives (AEs) managing active pipeline deals.
- **Job to be done:** Give an AE a real-time read on deal health, a scannable activity log, and an in-context competitive battlecard — all without leaving the deal record.

## User stories

- As an AE, I want to see a health score and urgency signals at a glance, so that I know which deals need immediate action without digging through activity feeds.
- As an AE, I want to filter the activity timeline by type, so that I can quickly find the last email or call without scrolling through unrelated entries.
- As an AE, I want to log a new activity from within the deal card, so that I can capture notes immediately after a call or meeting.
- As an AE, I want to expand any timeline entry to read the full notes, so that I can recall context before a follow-up.
- As an AE, I want to switch the battlecard between known competitors, so that I can pull up the right talking points and win-rate data for the specific deal I am in.
- As an AE, I want to see a side-by-side feature comparison table that updates when I change the competitor, so that I can handle objections with accurate, current information.

## UI structure

The card root is a vertical `Flex` with `gap="sm"` containing two regions: a persistent deal header and a tabbed content shell.

### Deal header (`deal-header`)

A compact `Tile` that spans the full width of the card and is always visible regardless of which tab is active. Inside it, a vertical `Flex` (`deal-header-inner`) contains two rows.

The first row (`deal-name-row`) is a horizontal `Flex` with three inline elements: a bold `Text` showing the deal name, a `StatusTag` showing the deal stage (variant driven by `dealStageVariant`), and a health score inline group (`health-score-inline`) — a `Flex` containing a gauge `Icon`, a `Text` showing the score out of 100, and a `StatusTag` showing the health label (variant driven by `healthScoreVariant`).

The second row is a `DescriptionList` (`deal-meta-dl`) in `direction="row"` with three `DescriptionListItem` entries — Owner, Close date, and Amount. Each item's value (children) is a `Flex` containing an `Icon` and a `Text`, placing the icon flush left of the value text while the label string sits above in the native DescriptionList style.

### Tab shell (`tab-shell`)

A `Tabs` component with three tabs: Pulse, Timeline, and Battlecard. The active tab is driven by `state.activeTab`.

#### Pulse tab (`tab-pulse`)

A vertical `Flex` with three sections.

The first section (`pulse-kpis`) is a `Statistics` component rendering a `StatisticsItem` for each entry in `data.kpis` via `$forEach`. Each item shows a label, a numeric value, and a `StatisticsTrend` child with a direction and label.

The second section is a header row (`pulse-urgency-header`) — a horizontal `Flex` with a warning `Icon` and a demibold `Text` reading "Needs attention".

The third section (`pulse-urgency-grid`) is an `AutoGrid` with `columnWidth=200`, `flexible=true`, `gap="small"`, and `align="stretch"`. It renders one `Tile` per entry in `data.urgencyTiles` via `$forEach`. Each tile contains a vertical `Flex` with `justify="space-between"` and `grow=true`: a top block with a `StatusTag` (variant from `tile.variant`, text from `tile.title`) and a microcopy `Text` (from `tile.detail`), and a bottom `Button` (secondary, xs) whose label comes from `tile.action`.

#### Timeline tab (`tab-timeline`)

A vertical `Flex` with two sections.

The header row (`timeline-header-row`) is a horizontal `Flex` with `justify="between"`: a transparent `Select` for filtering by activity type (`timeline-filter-select`, bound to `state.timelineFilter`) on the left, and a primary small `Button` labeled "Log activity" on the right. The Log activity button opens a `Panel` overlay (`log-activity-panel`) in modal variant with a small size. The panel body contains a `PanelSection` with a vertical `Flex` holding four inputs: a `Select` for activity type, an `Input` for title, a `DateInput` for date, and a `TextArea` for notes. The panel footer has Cancel (secondary, closes overlay) and Save activity (primary, closes overlay and fires a success `addAlert`) buttons.

The feed (`timeline-feed`) is a vertical `Flex` of five hardcoded `Tile` entries (`tl-item-1` through `tl-item-5`), each compact. Inside each tile, a vertical `Flex` shows a header row with a type `Icon` and a microcopy date `Text`, a `Link` whose text is the activity title, and a microcopy `Text` preview. Clicking the `Link` opens a `Panel` overlay (modal, small) with a `PanelSection` for Details (a `DescriptionList` with Type and Date items) and a `PanelSection` for Notes (a `Text` with the full note). The panel footer has a single Close button.

#### Battlecard tab (`tab-battlecard`)

A vertical `Flex` with three sections.

The header (`battlecard-header`) is a horizontal `Flex` with a demibold `Text` reading "Competing against" and a transparent `Select` (`comp-competitor-select`) bound to `state.competitor` with four options: Salesforce, Microsoft Dynamics, Pipedrive, Zoho CRM.

The KPI section (`battlecard-comp-kpis`) contains four `Statistics` components — one per competitor — each rendered via `$forEach` over its respective KPI array. Only the one matching `state.competitor` is visible; the others have `visible=false` via `$eq` expressions.

The comparison section (`battlecard-accordion-group`) is a `DataTable` (`battlecard-comparison-table`) with three columns: Criteria (plain text), HubSpot (value rendered as a `StatusTag` using `row.usVariant`), and a dynamic competitor column whose label and data source both switch based on `state.competitor` via nested `$if` chains. The table data resolves to one of four row arrays: `comparisonRows`, `dynamicsRows`, `pipedriveRows`, or `zohoRows`. `showRowCount` is false.

### Component tree

```
Flex (column, gap=sm) — card-root
├─ Tile (compact) — deal-header
│    └─ Flex (column, gap=xs) — deal-header-inner
│         ├─ Flex (row, align=center, gap=xs, wrap) — deal-name-row
│         │    ├─ Text (demibold) — dealName
│         │    ├─ StatusTag ($dealStageVariant) — dealStage
│         │    └─ Flex (row, align=center, gap=xs) — health-score-inline
│         │         ├─ Icon "gauge"
│         │         ├─ Text (microcopy) — "62 / 100"
│         │         └─ StatusTag ($healthScoreVariant) — healthScoreLabel
│         └─ DescriptionList (row) — deal-meta-dl
│              ├─ DescriptionListItem "Owner" → Flex [Icon "contact" + Text dealOwner]
│              ├─ DescriptionListItem "Close date" → Flex [Icon "date" + Text closeDate/daysToCloseLabel]
│              └─ DescriptionListItem "Amount" → Flex [Icon "invoice" + Text dealAmount]
└─ Tabs (selected=$state.activeTab) — tab-shell
     ├─ Tab "pulse"
     │    └─ Flex (column, gap=sm) — pulse-content
     │         ├─ Statistics — pulse-kpis
     │         │    └─ StatisticsItem ×3 (forEach $data.kpis)
     │         │         └─ StatisticsTrend
     │         ├─ Flex (row) — pulse-urgency-header
     │         │    ├─ Icon "warning"
     │         │    └─ Text (demibold) "Needs attention"
     │         └─ AutoGrid (columnWidth=200, flexible, align=stretch) — pulse-urgency-grid
     │              └─ Tile (compact) ×4 (forEach $data.urgencyTiles)
     │                   └─ Flex (column, justify=space-between, grow=true)
     │                        ├─ StatusTag ($tile.variant) — tile.title
     │                        ├─ Text (microcopy) — tile.detail
     │                        └─ Button (secondary, xs) — tile.action
     ├─ Tab "timeline"
     │    └─ Flex (column, gap=sm) — timeline-content
     │         ├─ Flex (row, justify=between) — timeline-header-row
     │         │    ├─ Select (transparent, $state.timelineFilter) — timeline-filter-select
     │         │    └─ Button (primary, small) "Log activity" → Panel overlay
     │         └─ Flex (column, gap=xs) — timeline-feed
     │              └─ Tile (compact) ×5 — tl-item-1 … tl-item-5
     │                   └─ Flex (column, gap=xs)
     │                        ├─ Flex (row) [Icon + Text date]
     │                        ├─ Link → Panel overlay (detail)
     │                        └─ Text (microcopy) — notePreview
     └─ Tab "battlecard"
          └─ Flex (column, gap=sm) — battlecard-content
               ├─ Flex (row, align=center) — battlecard-header
               │    ├─ Text (demibold) "Competing against"
               │    └─ Select (transparent, $state.competitor) — comp-competitor-select
               ├─ Flex (column, gap=xs) — battlecard-comp-kpis
               │    ├─ Statistics (visible if competitor=salesforce) — comp-kpis-salesforce
               │    ├─ Statistics (visible if competitor=dynamics) — comp-kpis-dynamics
               │    ├─ Statistics (visible if competitor=pipedrive) — comp-kpis-pipedrive
               │    └─ Statistics (visible if competitor=zoho) — comp-kpis-zoho
               └─ DataTable — battlecard-comparison-table
                    ├─ Column "Criteria"
                    ├─ Column "HubSpot" (StatusTag usVariant)
                    └─ Column [dynamic label] (StatusTag themVariant)
```

## View modes & state

- `activeTab` — `string` (initial: `"pulse"`). Controls which `Tab` is displayed in `tab-shell`. Mutated by selecting any tab in the `Tabs` component via `onSelectedChange` → `setState`.
- `timelineFilter` — `string` (initial: `"all"`). Bound to the `timeline-filter-select` Select via `$bindState`. In the current spec the filter value is captured in state but the timeline feed is five hardcoded `Tile` elements — no filtering logic is wired to hide or show items based on this value. See Edge cases.
- `viewMode` — `string` (initial: `"loaded"`). Present in state but not referenced by any conditional rendering in the spec. No loading, error, or empty visual states are implemented. See Edge cases.
- `competitor` — `string` (initial: `"salesforce"`). Controls which `Statistics` block is visible in the battlecard KPI section (via `visible` + `$eq`) and which row array and column label the `DataTable` uses (via nested `$if` chains). Mutated by the `comp-competitor-select` Select via `$bindState`.

## Data contract

- `dealName` — `string`. Full deal name displayed as the card title (e.g. `"Acme Corp — Enterprise"`).
- `dealStage` — `string`. Current pipeline stage label (e.g. `"Proposal Sent"`).
- `dealStageVariant` — `string`. HubSpot StatusTag variant for the stage tag (`"default"` | `"success"` | `"warning"` | `"danger"`).
- `closeDate` — `string`. Formatted close date string (e.g. `"Jun 30, 2025"`).
- `daysToClose` — `number`. Raw integer count of days until close date.
- `daysToCloseLabel` — `string`. Pre-formatted label (e.g. `"18 days"`).
- `dealAmount` — `string`. Formatted deal value string (e.g. `"$142,000"`).
- `dealOwner` — `string`. Display name of the deal owner (e.g. `"Sarah Chen"`).
- `healthScore` — `number`. Integer 0–100 health score.
- `healthScoreVariant` — `string`. StatusTag variant for the health badge.
- `healthScoreLabel` — `string`. Human-readable health label (e.g. `"At Risk"`).
- `kpis` — `array` of objects. Each item: `label` (string), `value` (string), `trendLabel` (string), `trendDirection` (`"increase"` | `"decrease"`). Rendered in the Pulse tab Statistics block.
- `urgencyTiles` — `array` of objects. Each item: `id` (string), `title` (string), `detail` (string), `variant` (StatusTag variant string), `icon` (icon name string), `action` (string — button label). Rendered in the urgency AutoGrid.
- `timelineItems` — `array` of objects. Each item: `id`, `type`, `date` (formatted string), `dateSort` (ISO date string), `title`, `notePreview` (short string), `note` (full string), `typeVariant`, `icon`. Present in data but not consumed by the current hardcoded timeline feed.
- `timelineFilterOptions` — `array` of `{label, value}` objects. Present in data but the Select uses inline options, not this array.
- `timelineTypeOptions` — `array` of `{label, value}` objects. Present in data; unused in the current spec.
- `competitorOptions` — `array` of `{label, value}` objects. Present in data; the competitor Select uses inline options, not this array.
- `competitorKpis` — `array` of KPI objects (same shape as `kpis`). Present in data but not referenced by any element — superseded by the four per-competitor arrays.
- `salesforceKpis` / `dynamicsKpis` / `pipedriveKpis` / `zohoKpis` — `array` of objects, each: `label` (string), `value` (string), `trendLabel` (string), `trendDirection` (string). One array per competitor, rendered by the corresponding `Statistics` node.
- `comparisonRows` — `array` of objects. Each item: `criteria` (string), `us` (string), `usVariant` (StatusTag variant), `them` (string), `themVariant` (StatusTag variant). Used as the DataTable source when competitor is `"salesforce"`.
- `dynamicsRows` / `pipedriveRows` / `zohoRows` — same shape as `comparisonRows`. Used as DataTable source for the respective competitor.
- `battlecardCategories` — `array` of objects. Each item: `id`, `category`, `icon`, `iconColor`, `default