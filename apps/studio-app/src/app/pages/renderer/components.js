import React from "react";
import * as HS from "@hubspot/ui-extensions";
import * as HSExperimental from "@hubspot/ui-extensions/experimental";
import * as HSUIX from "hs-uix";
import {
  ICON_NAMES,
  ICON_NAME_ALIASES,
  EMPTY_STATE_IMAGES,
  EMPTY_STATE_IMAGE_ALIASES,
  TREND_DIRECTIONS,
  TREND_DIRECTION_ALIASES,
} from "./catalogs.js";

// Components available to specs by `type` name.
const HS_NAMES = [
  "Accordion", "Alert", "AutoGrid", "BarChart", "Box", "Button", "ButtonRow",
  "Card", "Checkbox", "CurrencyInput", "DateInput", "DescriptionList",
  "DescriptionListItem", "Divider", "Dropdown", "EmptyState", "ErrorState",
  "Flex", "Form", "Heading", "Icon", "Illustration", "Image", "Inline", "Input",
  "LineChart", "Link", "List", "LoadingButton", "LoadingSpinner", "Modal",
  "ModalBody", "ModalFooter", "MultiSelect", "NumberInput", "Panel", "PanelBody",
  "PanelFooter", "PanelSection", "ProgressBar", "RadioButton", "ScoreCircle",
  "SearchInput", "Select", "Spacer", "Stack", "Statistics", "StatisticsItem",
  "StatisticsTrend", "StatusTag", "StepIndicator", "StepperInput", "Tab",
  "Table", "TableBody", "TableCell", "TableFooter", "TableHead", "TableHeader",
  "TableRow", "Tabs", "Tag", "Text", "TextArea", "Textarea", "Tile", "TimeInput",
  "Toggle", "ToggleGroup", "Tooltip",
];

const HSUIX_NAMES = [
  "DataTable", "Kanban", "KanbanCardActions", "FormBuilder",
  "AutoTag", "AutoStatusTag", "KeyValueList", "SectionHeader",
  "AvatarStack", "StyledText",
  // hs-uix 2.1.0 additions. Only the root-barrel ("hs-uix") runtime exports
  // are listed — the Collection* primitives and ActiveFilterChips ship only
  // from the "hs-uix/common-components" subpath (the root type declarations
  // are ahead of the build), and they're controlled components that can't be
  // driven by a declarative spec anyway, so they're intentionally omitted.
  "Feed", "Calendar", "CrmLookupSelect", "CrmDataTable", "CrmKanban", "Spinner",
  // hs-uix 2.3 additions. All three support uncontrolled `defaultValue` mode,
  // so specs can drive them without wiring value/onChange by hand.
  "CrmRecordPicker", "DateRangePicker", "FilterBuilder",
];

const rawComponents = {};
for (const name of HS_NAMES) {
  if (HS[name]) rawComponents[name] = HS[name];
}
for (const name of HSUIX_NAMES) {
  if (HSUIX[name]) rawComponents[name] = HSUIX[name];
}

// Compound components used by specs with dotted type names.
// Also include common typo aliases so one bad character doesn't blank an
// action menu with "Unknown component" placeholders.
if (HS.Dropdown?.ButtonItem) {
  rawComponents["Dropdown.ButtonItem"] = HS.Dropdown.ButtonItem;
  rawComponents["Dropdown.Buttonltem"] = HS.Dropdown.ButtonItem; // typo: lowercase L instead of I
}

// Experimental components from @hubspot/ui-extensions/experimental.
// Guarded by presence check so older @hubspot/ui-extensions versions that
// don't ship the subpath don't break the whole renderer.
if (HSExperimental?.ExpandableText) {
  rawComponents["ExpandableText"] = HSExperimental.ExpandableText;
}
if (HSExperimental?.Popover) {
  rawComponents["Popover"] = HSExperimental.Popover;
}
// File attachment pair: FileUpload uploads to the portal's file manager (and
// optionally attaches to a CRM record); FileViewer lists files uploaded by
// this app, auto-refreshing when a sibling FileUpload completes. FileInput is
// deliberately NOT mapped — its .d.ts marks it `@ignore do not use in
// production` and it's a low-level controlled input a spec can't drive.
if (HSExperimental?.FileUpload) {
  rawComponents["FileUpload"] = HSExperimental.FileUpload;
}
if (HSExperimental?.FileViewer) {
  rawComponents["FileViewer"] = HSExperimental.FileViewer;
}

// ---- Icon safety net ------------------------------------------------------
//
// The platform Icon silently drops invalid `name` props (no error, empty
// render). That made generator mistakes nearly impossible to debug. Wrap
// it so:
//   - Known aliases (duplicate→copy, alert→warning, etc.) auto-repair.
//   - Unknown names render a visible `xCircle` placeholder in alert color
//     with screenReaderText = "Invalid icon: <bad-name>", plus a warn log.
// This turns silent visual bugs into loud ones.

const warnedIcons = new Set();
function warnOnce(key, message) {
  if (warnedIcons.has(key)) return;
  warnedIcons.add(key);
  console.warn(message);
}

function arrayProp(value, componentName, propName) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  warnOnce(
    `${componentName}-${propName}-not-array`,
    `[Canvas] ${componentName}.${propName} must be an array — received ${typeof value}; using [].`,
  );
  return [];
}

function withSafeArrayProps(Component, componentName, propNames) {
  if (!Component) return undefined;
  const SafeComponent = (props) => {
    const next = { ...(props || {}) };
    for (const propName of propNames) {
      next[propName] = arrayProp(next[propName], componentName, propName);
    }
    return React.createElement(Component, next);
  };
  SafeComponent.displayName = `Safe${componentName}`;
  return SafeComponent;
}

const RawIcon = rawComponents.Icon;
const SafeIcon = RawIcon
  ? (props) => {
      const { name, ...rest } = props || {};
      if (typeof name === "string" && ICON_NAMES.has(name)) {
        return React.createElement(RawIcon, { name, ...rest });
      }
      const alias = ICON_NAME_ALIASES[name];
      if (alias && ICON_NAMES.has(alias)) {
        warnOnce(
          `icon-alias-${name}`,
          `[Canvas] Icon name "${name}" is not in the catalog — auto-repaired to "${alias}".`,
        );
        return React.createElement(RawIcon, { name: alias, ...rest });
      }
      warnOnce(
        `icon-invalid-${name}`,
        `[Canvas] Icon name "${name}" is not in the catalog. Rendering a red xCircle placeholder. See renderer/catalogs.js for the valid list.`,
      );
      // Spread `rest` first so our placeholder defaults (name, color,
      // screenReaderText) always win — otherwise a spec-level color prop
      // like "success" bleeds through and the placeholder renders green.
      return React.createElement(RawIcon, {
        ...rest,
        name: "xCircle",
        color: "alert",
        screenReaderText: `Invalid icon: ${name ?? "(missing)"}`,
      });
    }
  : undefined;
if (SafeIcon) SafeIcon.displayName = "SafeIcon";

// ---- EmptyState safety net -----------------------------------------------
//
// EmptyState throws (user saw: "new-project is not a valid option for
// imageName") rather than silently dropping — but the throw aborts the
// render. Swap bad imageName to a known good fallback and warn.

const RawEmptyState = rawComponents.EmptyState;
const SafeEmptyState = RawEmptyState
  ? (props) => {
      const { imageName, ...rest } = props || {};
      if (imageName == null || EMPTY_STATE_IMAGES.has(imageName)) {
        return React.createElement(RawEmptyState, { imageName, ...rest });
      }
      const alias = EMPTY_STATE_IMAGE_ALIASES[imageName];
      const fallback = alias && EMPTY_STATE_IMAGES.has(alias) ? alias : "components";
      warnOnce(
        `emptystate-image-${imageName}`,
        `[Canvas] EmptyState imageName "${imageName}" is not valid — using "${fallback}". See renderer/catalogs.js.`,
      );
      return React.createElement(RawEmptyState, { imageName: fallback, ...rest });
    }
  : undefined;
if (SafeEmptyState) SafeEmptyState.displayName = "SafeEmptyState";

// ---- StatisticsTrend safety net ------------------------------------------
//
// `direction` accepts "increase" | "decrease" only. Generator keeps
// producing "increasing" / "decreasing" (or occasional "up"/"down"). Alias
// silently so renders don't toast "not a valid option".

const RawStatisticsTrend = rawComponents.StatisticsTrend;
const SafeStatisticsTrend = RawStatisticsTrend
  ? (props) => {
      const { direction, ...rest } = props || {};
      if (
        typeof direction !== "string" ||
        TREND_DIRECTIONS.has(direction)
      ) {
        return React.createElement(RawStatisticsTrend, { direction, ...rest });
      }
      const alias = TREND_DIRECTION_ALIASES[direction];
      if (alias && TREND_DIRECTIONS.has(alias)) {
        warnOnce(
          `trend-alias-${direction}`,
          `[Canvas] StatisticsTrend direction "${direction}" → "${alias}". Valid values: increase, decrease.`,
        );
        return React.createElement(RawStatisticsTrend, {
          direction: alias,
          ...rest,
        });
      }
      warnOnce(
        `trend-invalid-${direction}`,
        `[Canvas] StatisticsTrend direction "${direction}" is not valid — defaulting to "increase".`,
      );
      return React.createElement(RawStatisticsTrend, {
        ...rest,
        direction: "increase",
      });
    }
  : undefined;
if (SafeStatisticsTrend) SafeStatisticsTrend.displayName = "SafeStatisticsTrend";

// ---- Popover padding default --------------------------------------------
//
// The experimental Popover renders its children flush with no internal
// padding, which looks cramped next to documented overlays (Modal/Panel)
// that ship with their own spacing. Auto-wrap children in a compact Tile
// so specs don't have to remember the workaround. If the spec already
// nests its content in a Tile, we still wrap — the inner Tile becomes a
// content block inside the padded shell, which renders fine.

const RawPopover = rawComponents.Popover;
const RawTile = rawComponents.Tile;
const SafePopover =
  RawPopover && RawTile
    ? (props) => {
        const { children, ...rest } = props || {};
        return React.createElement(
          RawPopover,
          rest,
          React.createElement(RawTile, { compact: true }, children),
        );
      }
    : RawPopover;
if (SafePopover && SafePopover !== RawPopover) {
  SafePopover.displayName = "SafePopover";
}

// ---- hs-uix required-array safety net ------------------------------------
//
// Model-generated specs sometimes reference a missing data path (for example
// `data="$data.rows"` when the data key is actually `deals`). Several hs-uix
// components assume required array props are present and can throw inside the
// reconciler (`Cannot read properties of undefined (reading 'length')`), which
// blanks the whole page in production. Coerce those required collection props
// to [] so the preview degrades to an empty state instead of crashing.

const SafeDataTable = withSafeArrayProps(rawComponents.DataTable, "DataTable", [
  "data",
  "columns",
  "searchFields",
  "filters",
  "selectionActions",
]);
const SafeKanban = withSafeArrayProps(rawComponents.Kanban, "Kanban", [
  "data",
  "stages",
]);
const SafeFormBuilder = withSafeArrayProps(rawComponents.FormBuilder, "FormBuilder", [
  "fields",
]);
const SafeAvatarStack = withSafeArrayProps(rawComponents.AvatarStack, "AvatarStack", [
  "items",
]);
const SafeKeyValueList = withSafeArrayProps(rawComponents.KeyValueList, "KeyValueList", [
  "items",
]);
const SafeSelect = withSafeArrayProps(rawComponents.Select, "Select", [
  "options",
]);
const SafeMultiSelect = withSafeArrayProps(rawComponents.MultiSelect, "MultiSelect", [
  "options",
]);
const SafeToggleGroup = withSafeArrayProps(rawComponents.ToggleGroup, "ToggleGroup", [
  "options",
]);
const SafeStepIndicator = withSafeArrayProps(rawComponents.StepIndicator, "StepIndicator", [
  "steps",
]);

// hs-uix 2.1.0 components with required collection props. Same rationale as
// above — a missing `$data.x` path should degrade to an empty view, not throw
// inside the reconciler and blank the page.
const SafeFeed = withSafeArrayProps(rawComponents.Feed, "Feed", [
  "items",
  "fields",
]);
const SafeCalendar = withSafeArrayProps(rawComponents.Calendar, "Calendar", [
  "events",
]);
const SafeCrmDataTable = withSafeArrayProps(rawComponents.CrmDataTable, "CrmDataTable", [
  "columns",
]);
const SafeCrmKanban = withSafeArrayProps(rawComponents.CrmKanban, "CrmKanban", [
  "stages",
  "cardFields",
]);

export const components = {
  ...rawComponents,
  ...(SafeIcon ? { Icon: SafeIcon } : {}),
  ...(SafeEmptyState ? { EmptyState: SafeEmptyState } : {}),
  ...(SafeStatisticsTrend ? { StatisticsTrend: SafeStatisticsTrend } : {}),
  ...(SafePopover ? { Popover: SafePopover } : {}),
  ...(SafeDataTable ? { DataTable: SafeDataTable } : {}),
  ...(SafeKanban ? { Kanban: SafeKanban } : {}),
  ...(SafeFormBuilder ? { FormBuilder: SafeFormBuilder } : {}),
  ...(SafeAvatarStack ? { AvatarStack: SafeAvatarStack } : {}),
  ...(SafeKeyValueList ? { KeyValueList: SafeKeyValueList } : {}),
  ...(SafeSelect ? { Select: SafeSelect } : {}),
  ...(SafeMultiSelect ? { MultiSelect: SafeMultiSelect } : {}),
  ...(SafeToggleGroup ? { ToggleGroup: SafeToggleGroup } : {}),
  ...(SafeStepIndicator ? { StepIndicator: SafeStepIndicator } : {}),
  ...(SafeFeed ? { Feed: SafeFeed } : {}),
  ...(SafeCalendar ? { Calendar: SafeCalendar } : {}),
  ...(SafeCrmDataTable ? { CrmDataTable: SafeCrmDataTable } : {}),
  ...(SafeCrmKanban ? { CrmKanban: SafeCrmKanban } : {}),
};
