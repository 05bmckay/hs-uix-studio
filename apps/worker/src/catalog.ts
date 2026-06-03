// Component + action catalog — the single source of truth for what specs are
// allowed to contain. Consumed by:
//   - validateSpec() in tools/validate.ts (unknown component / action errors)
//   - toPromptSection() below (component index injected into the system prompt
//     via the {{CATALOG}} marker)
//   - the studio-app renderer's known-types check (synced via the
//     componentNames array, written to a .generated file at build time)
//
// Props-level Zod schemas are intentionally NOT modeled yet. The goal for this
// phase is: kill hallucinated component names, kill broken $action descriptors.
// Prop shape validation can land in a follow-up — the full nuance is carried
// by the hand-written standards/*.md files today and isn't practical to
// machine-encode in one pass.

import { z } from "zod";

export type Category =
  | "layout"
  | "typography"
  | "action"
  | "form"
  | "data-display"
  | "state"
  | "chart"
  | "overlay"
  | "table"
  | "navigation"
  | "status"
  | "media"
  | "hs-uix";

export interface ComponentEntry {
  name: string;
  category: Category;
  description: string;
  source: "hubspot" | "hs-uix";
}

// Keep aligned with apps/studio-app/src/app/pages/renderer/components.js.
// Any component the renderer maps must appear here so validateSpec recognizes
// it. A component can live here without being in the renderer map (e.g. a
// deprecation target) but NOT the other way around.
export const COMPONENTS: ComponentEntry[] = [
  // ---- Layout (hubspot) -----------------------------------------------------
  { name: "Flex",        category: "layout",  source: "hubspot", description: "Primary row/column layout primitive." },
  { name: "Box",         category: "layout",  source: "hubspot", description: "Flex ratio container — e.g. `flex={1}`." },
  { name: "AutoGrid",    category: "layout",  source: "hubspot", description: "Responsive multi-column grid with `columnWidth`." },
  { name: "Inline",      category: "layout",  source: "hubspot", description: "Grouping inside justify=between parents." },
  { name: "Tile",        category: "layout",  source: "hubspot", description: "Bordered container for triage cards and chart frames." },
  { name: "Divider",     category: "layout",  source: "hubspot", description: "Visual separator between sections." },
  { name: "Spacer",      category: "layout",  source: "hubspot", description: "One-off vertical/horizontal spacing." },
  { name: "Stack",       category: "layout",  source: "hubspot", description: "Legacy layout — prefer Flex." },

  // ---- Typography -----------------------------------------------------------
  { name: "Heading",     category: "typography", source: "hubspot", description: "Section/card heading." },
  { name: "Text",        category: "typography", source: "hubspot", description: "Paragraph, microcopy, caption." },
  { name: "Link",        category: "typography", source: "hubspot", description: "Secondary/tertiary action or inline reference." },

  // ---- Actions --------------------------------------------------------------
  { name: "Button",         category: "action", source: "hubspot", description: "Primary surface action; supports `overlay` for Modal/Panel." },
  { name: "ButtonRow",      category: "action", source: "hubspot", description: "Row of 2–3 buttons with overflow." },
  { name: "LoadingButton",  category: "action", source: "hubspot", description: "Button with async loading state." },
  { name: "Dropdown",       category: "action", source: "hubspot", description: "Multi-action menu / table-row actions." },

  // ---- Forms ----------------------------------------------------------------
  { name: "Form",           category: "form", source: "hubspot", description: "Form container." },
  { name: "Input",          category: "form", source: "hubspot", description: "Single-line text input." },
  { name: "TextArea",       category: "form", source: "hubspot", description: "Multi-line text input (canonical casing)." },
  { name: "Textarea",       category: "form", source: "hubspot", description: "Alias for TextArea." },
  { name: "NumberInput",    category: "form", source: "hubspot", description: "Numeric input." },
  { name: "CurrencyInput",  category: "form", source: "hubspot", description: "Numeric input with currency affordance." },
  { name: "DateInput",      category: "form", source: "hubspot", description: "Date picker." },
  { name: "TimeInput",      category: "form", source: "hubspot", description: "Time picker." },
  { name: "StepperInput",   category: "form", source: "hubspot", description: "Stepper for bounded integer values." },
  { name: "SearchInput",    category: "form", source: "hubspot", description: "Search field, typically above a list." },
  { name: "Select",         category: "form", source: "hubspot", description: "Single-select dropdown." },
  { name: "MultiSelect",    category: "form", source: "hubspot", description: "Multi-select dropdown." },
  { name: "Checkbox",       category: "form", source: "hubspot", description: "Single checkbox." },
  { name: "RadioButton",    category: "form", source: "hubspot", description: "Single radio option (normally inside a group)." },
  { name: "Toggle",         category: "form", source: "hubspot", description: "On/off switch." },
  { name: "ToggleGroup",    category: "form", source: "hubspot", description: "Toggle-button group (Segmented-ish)." },

  // ---- Data display ---------------------------------------------------------
  { name: "DescriptionList",      category: "data-display", source: "hubspot", description: "Label/value rows." },
  { name: "DescriptionListItem",  category: "data-display", source: "hubspot", description: "One label/value row." },
  { name: "Statistics",           category: "data-display", source: "hubspot", description: "KPI row container." },
  { name: "StatisticsItem",       category: "data-display", source: "hubspot", description: "Individual stat tile." },
  { name: "StatisticsTrend",      category: "data-display", source: "hubspot", description: "Trend delta inside a stat." },
  { name: "List",                 category: "data-display", source: "hubspot", description: "Bulleted/numbered list." },
  { name: "ProgressBar",          category: "data-display", source: "hubspot", description: "Horizontal progress indicator." },
  { name: "ScoreCircle",          category: "data-display", source: "hubspot", description: "Circular score gauge." },
  { name: "Image",                category: "media",        source: "hubspot", description: "Static image." },
  { name: "Illustration",         category: "media",        source: "hubspot", description: "Decorative illustration asset." },
  { name: "Icon",                 category: "media",        source: "hubspot", description: "Icon glyph by name." },

  // ---- Tables ---------------------------------------------------------------
  { name: "Table",        category: "table", source: "hubspot", description: "Raw table — prefer DataTable." },
  { name: "TableHead",    category: "table", source: "hubspot", description: "Raw table head." },
  { name: "TableBody",    category: "table", source: "hubspot", description: "Raw table body." },
  { name: "TableFooter",  category: "table", source: "hubspot", description: "Raw table footer." },
  { name: "TableRow",     category: "table", source: "hubspot", description: "Raw table row." },
  { name: "TableCell",    category: "table", source: "hubspot", description: "Raw table cell." },
  { name: "TableHeader",  category: "table", source: "hubspot", description: "Raw table column header." },

  // ---- Navigation / Grouping -----------------------------------------------
  { name: "Accordion",      category: "navigation", source: "hubspot", description: "Expandable section." },
  { name: "Tabs",           category: "navigation", source: "hubspot", description: "Tab group." },
  { name: "Tab",            category: "navigation", source: "hubspot", description: "Single tab inside Tabs." },
  { name: "StepIndicator",  category: "navigation", source: "hubspot", description: "Progress steps / wizard indicator." },
  { name: "Tooltip",        category: "navigation", source: "hubspot", description: "Hover tip wrapping children." },

  // ---- Status / States ------------------------------------------------------
  { name: "Alert",          category: "state",  source: "hubspot", description: "Inline status banner — only when action is required." },
  { name: "EmptyState",     category: "state",  source: "hubspot", description: "Empty-list placeholder." },
  { name: "ErrorState",     category: "state",  source: "hubspot", description: "Error placeholder." },
  { name: "LoadingSpinner", category: "state",  source: "hubspot", description: "Loading indicator." },
  { name: "Tag",            category: "status", source: "hubspot", description: "Static category tag." },
  { name: "StatusTag",      category: "status", source: "hubspot", description: "Status pill with explicit variant." },
  { name: "Card",           category: "layout", source: "hubspot", description: "Bordered card frame." },

  // ---- Overlays -------------------------------------------------------------
  { name: "Modal",          category: "overlay", source: "hubspot", description: "Centered modal dialog." },
  { name: "ModalBody",      category: "overlay", source: "hubspot", description: "Modal body slot." },
  { name: "ModalFooter",    category: "overlay", source: "hubspot", description: "Modal action row." },
  { name: "Panel",          category: "overlay", source: "hubspot", description: "Side panel dialog." },
  { name: "PanelBody",      category: "overlay", source: "hubspot", description: "Panel body slot." },
  { name: "PanelFooter",    category: "overlay", source: "hubspot", description: "Panel action row." },
  { name: "PanelSection",   category: "overlay", source: "hubspot", description: "Grouped section inside PanelBody." },

  // ---- Charts ---------------------------------------------------------------
  { name: "BarChart",       category: "chart", source: "hubspot", description: "Bar chart." },
  { name: "LineChart",      category: "chart", source: "hubspot", description: "Line chart." },

  // ---- hs-uix ---------------------------------------------------------------
  { name: "DataTable",        category: "table",        source: "hs-uix", description: "Default list primitive. Built-in search/filter/pagination." },
  { name: "Kanban",           category: "data-display", source: "hs-uix", description: "Kanban board — columns of cards." },
  { name: "KanbanCardActions",category: "data-display", source: "hs-uix", description: "Action row inside a Kanban card." },
  { name: "FormBuilder",      category: "form",         source: "hs-uix", description: "Declarative form from a `fields` array." },
  { name: "AutoTag",          category: "status",       source: "hs-uix", description: "Tag with variant auto-picked from value." },
  { name: "AutoStatusTag",    category: "status",       source: "hs-uix", description: "StatusTag with variant auto-picked." },
  { name: "KeyValueList",     category: "data-display", source: "hs-uix", description: "Flat key/value list primitive." },
  { name: "SectionHeader",    category: "typography",   source: "hs-uix", description: "Demibold title + optional description row." },
  { name: "AvatarStack",      category: "media",        source: "hs-uix", description: "Overlapping avatars with overflow count." },
  { name: "StyledText",       category: "typography",   source: "hs-uix", description: "Text with inline format overrides." },

  // ---- hs-uix 2.1.0 ---------------------------------------------------------
  { name: "Feed",             category: "data-display", source: "hs-uix", description: "Activity feed / timeline. Declarative `fields` with placement, date grouping, tabs, filters, load-more." },
  { name: "Calendar",         category: "data-display", source: "hs-uix", description: "Month/week/day/agenda calendar from `events` + `eventFields`. Presentational; caller owns fetching." },
  { name: "CrmLookupSelect",  category: "form",         source: "hs-uix", description: "CRM-backed Select/MultiSelect with debounced live search (objectType + properties)." },
  { name: "CrmDataTable",     category: "table",        source: "hs-uix", description: "DataTable that batch-fetches + client-paginates CRM records for an objectType." },
  { name: "CrmKanban",        category: "data-display", source: "hs-uix", description: "Kanban that batch-fetches CRM records for an objectType." },
  { name: "Spinner",          category: "state",        source: "hs-uix", description: "Animated braille/unicode loading indicator (inline, sized)." },
  { name: "CollectionToolbar",        category: "data-display", source: "hs-uix", description: "Escape hatch — the shared search/filter/sort toolbar behind DataTable/Feed/Calendar. Prefer the packaged components." },
  { name: "CollectionFilterControl",  category: "data-display", source: "hs-uix", description: "Escape hatch — single filter control (select/multiselect/dateRange) used inside CollectionToolbar." },
  { name: "CollectionSortSelect",     category: "data-display", source: "hs-uix", description: "Escape hatch — sort dropdown used inside CollectionToolbar." },
  { name: "CollectionCount",          category: "data-display", source: "hs-uix", description: "Escape hatch — visible/total record count label used inside CollectionToolbar." },
  { name: "ActiveFilterChips",        category: "data-display", source: "hs-uix", description: "Escape hatch — removable active-filter chip row. DataTable/Feed render their own; use standalone only for custom toolbars." },
];

export const COMPONENT_NAMES: Set<string> = new Set(COMPONENTS.map((c) => c.name));

// ---------------------------------------------------------------------------
// Actions — $action descriptors attached to event-handler props.
// ---------------------------------------------------------------------------

// Params may contain unresolved `$state.x` / `$data.x` references or template
// strings, so we accept z.unknown() for most fields. The goal is to validate
// SHAPE (required keys, known kind) not resolved values.
const anyValue = z.unknown();

export const ACTIONS = {
  setState: {
    description: "Renderer-native. Set a state key on the preview state object.",
    params: z.object({ key: z.string(), value: anyValue }).strict(),
  },
  batch: {
    description: "Renderer-native. Fire multiple actions from one gesture.",
    // actions[] is validated downstream when each descriptor dispatches.
    params: z.object({ actions: z.array(z.record(z.string(), anyValue)) }).strict(),
  },
  addAlert: {
    description: "SDK actions.addAlert({title, message, type}).",
    params: z.object({
      title: anyValue.optional(),
      message: anyValue,
      type: z.enum(["info", "tip", "success", "warning", "danger"]).optional(),
    }).strict(),
  },
  copyTextToClipboard: {
    description: "SDK actions.copyTextToClipboard(value).",
    params: z.object({ value: anyValue }).strict(),
  },
  // Back-compat alias for earlier specs.
  copyToClipboard: {
    description: "Alias for copyTextToClipboard.",
    params: z.object({ value: anyValue }).strict(),
  },
  reloadPage: {
    description: "SDK actions.reloadPage(). No-op in preview unless confirmReload: true.",
    params: z.object({ confirmReload: z.boolean().optional() }).strict(),
  },
  closeOverlay: {
    description: "SDK actions.closeOverlay(id).",
    params: z.object({ id: anyValue }).strict(),
  },
  openIframeModal: {
    description: "SDK actions.openIframeModal({uri, height, width, title?, flush?}).",
    params: z.object({
      uri: anyValue,
      height: anyValue,
      width: anyValue,
      title: anyValue.optional(),
      flush: anyValue.optional(),
    }).strict(),
  },
  refreshObjectProperties: {
    description: "SDK (CRM-only) actions.refreshObjectProperties().",
    params: z.object({}).strict(),
  },
} as const;

export type ActionKind = keyof typeof ACTIONS;
export const ACTION_KINDS: Set<string> = new Set(Object.keys(ACTIONS));

// ---------------------------------------------------------------------------
// Prompt-section generation
// ---------------------------------------------------------------------------

// Produces a compact markdown block suitable for inlining via {{CATALOG}} in
// the system prompt. Intentionally terse — the rule-heavy nuance lives in
// knowledge/standards/*.md (COMPONENTS.md etc.) and is loaded via tools.
export function toPromptSection(): string {
  const byCategory = new Map<Category, ComponentEntry[]>();
  for (const c of COMPONENTS) {
    const bucket = byCategory.get(c.category) ?? [];
    bucket.push(c);
    byCategory.set(c.category, bucket);
  }

  const order: Category[] = [
    "layout", "typography", "action", "form", "data-display",
    "table", "chart", "navigation", "state", "status", "media", "overlay",
    "hs-uix",
  ];

  const lines: string[] = ["## Component index", ""];
  for (const cat of order) {
    const entries = byCategory.get(cat);
    if (!entries || entries.length === 0) continue;
    lines.push(`### ${titleCase(cat)}`);
    for (const e of entries) {
      lines.push(`- **${e.name}** — ${e.description}`);
    }
    lines.push("");
  }

  lines.push("## Action kinds");
  lines.push("");
  for (const [kind, def] of Object.entries(ACTIONS)) {
    lines.push(`- **\`${kind}\`** — ${def.description}`);
  }
  return lines.join("\n");
}

function titleCase(s: string): string {
  return s.replace(/(^|-)(\w)/g, (_, sep, c) => (sep ? " " : "") + c.toUpperCase());
}
