// lintSpec — walks the spec and flags render-time problems that the
// HubSpot platform would toast at the user (bottom-left notifications).
// Runs *after* repairSpec, so the surface is "issues the auto-repair
// could not fix". The output is piped back to the model in the tool
// result so it self-corrects on the very next turn — the preview is
// still rendered regardless, since most findings are still renderable
// (just with fallback glyphs, wrong arrows, or ugly nesting).
//
// Add a new rule by:
//   1. Extending the union in `LintIssue.rule`
//   2. Adding a `check*` function
//   3. Invoking it from `walk`

import {
  ICON_NAMES,
  ICON_NAME_ALIASES,
  EMPTY_STATE_IMAGES,
  EMPTY_STATE_IMAGE_ALIASES,
  TREND_DIRECTIONS,
  TREND_DIRECTION_ALIASES,
} from "./repair";

export type LintSeverity = "warning" | "error";

export interface LintIssue {
  path: string;
  rule:
    | "icon.name-required"
    | "icon.name-alias"
    | "icon.name-invalid"
    | "icon.nested-in-text"
    | "emptystate.imagename-alias"
    | "emptystate.imagename-invalid"
    | "trend.direction-alias"
    | "trend.direction-invalid"
    | "button.children-contract";
  severity: LintSeverity;
  message: string;
}

// Parents that enforce "only Icon or Text as children" (per the HubSpot
// platform's own runtime error).
const RESTRICTIVE_CHILD_PARENTS = new Set(["Button", "LoadingButton", "Link"]);

// What those parents will accept.
const RESTRICTIVE_CHILD_ALLOWLIST = new Set([
  "Icon",
  "Text",
  "StyledText",
  "LoadingSpinner",
]);

export function lintSpec(spec: unknown): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!isObject(spec)) return issues;

  const elements = isObject((spec as Record<string, unknown>).elements)
    ? ((spec as Record<string, unknown>).elements as Record<string, unknown>)
    : null;

  const walk = (node: unknown, path: string, parentType: string | null): void => {
    if (node == null) return;
    if (typeof node === "string") {
      if (elements && node in elements) {
        walk(elements[node], `elements["${node}"]`, parentType);
      }
      return;
    }
    if (!isObject(node)) return;

    // Inline templates — walk their template node.
    if ("$forEach" in node && isObject((node as { render?: unknown }).render)) {
      walk(
        (node as { render: Record<string, unknown> }).render,
        `${path}.render`,
        parentType,
      );
      return;
    }
    if ("$render" in node && isObject((node as { node?: unknown }).node)) {
      walk(
        (node as { node: Record<string, unknown> }).node,
        `${path}.node`,
        parentType,
      );
      return;
    }

    const type = typeof node.type === "string" ? node.type : null;
    if (!type) return;

    checkIcon(node, path, issues);
    checkEmptyState(node, path, issues);
    checkTrendDirection(node, path, issues);
    checkRestrictiveChildren(node, path, issues);
    checkIconInText(node, path, parentType, issues);

    const children = node.children;
    if (Array.isArray(children)) {
      children.forEach((child, i) => walk(child, `${path}.children[${i}]`, type));
    } else if (isObject(children)) {
      walk(children, `${path}.children`, type);
    } else if (typeof children === "string") {
      if (elements && children in elements) {
        walk(elements[children], `elements["${children}"]`, type);
      }
    }

    // Overlay and renderCell markers can carry nested nodes in prop
    // positions — walk them one level deep so inline Icons in those
    // places lint too.
    for (const [key, val] of Object.entries(node)) {
      if (
        key === "children" ||
        key === "render" ||
        key === "node" ||
        key === "type"
      )
        continue;
      if (Array.isArray(val)) {
        val.forEach((v, i) => {
          if (isObject(v) && typeof (v as { type?: unknown }).type === "string") {
            walk(v, `${path}.${key}[${i}]`, type);
          }
        });
      } else if (
        isObject(val) &&
        typeof (val as { type?: unknown }).type === "string"
      ) {
        walk(val, `${path}.${key}`, type);
      }
    }
  };

  if (elements && typeof (spec as { root?: unknown }).root === "string") {
    const rootId = (spec as { root: string }).root;
    if (rootId in elements) {
      walk(elements[rootId], `elements["${rootId}"]`, null);
    }
  } else if (isObject((spec as { root?: unknown }).root)) {
    walk((spec as { root: Record<string, unknown> }).root, "root", null);
  }

  return issues;
}

// ---- rules ---------------------------------------------------------------

function checkIcon(
  node: Record<string, unknown>,
  path: string,
  issues: LintIssue[],
): void {
  if (node.type !== "Icon") return;
  const name = node.name;
  if (typeof name !== "string" || name === "") {
    issues.push({
      path,
      rule: "icon.name-required",
      severity: "error",
      message: "Icon requires a `name` prop. There is no default glyph.",
    });
    return;
  }
  if (ICON_NAMES.has(name)) return;
  if (ICON_NAME_ALIASES[name]) {
    issues.push({
      path,
      rule: "icon.name-alias",
      severity: "warning",
      message: `Icon name "${name}" was auto-repaired to "${ICON_NAME_ALIASES[name]}". Use the canonical name next time.`,
    });
    return;
  }
  issues.push({
    path,
    rule: "icon.name-invalid",
    severity: "error",
    message: `Icon name "${name}" is not in the 190-name SDK catalog. It rendered as a red xCircle placeholder. Pick a valid name from media.md.`,
  });
}

function checkEmptyState(
  node: Record<string, unknown>,
  path: string,
  issues: LintIssue[],
): void {
  if (node.type !== "EmptyState") return;
  const imageName = node.imageName;
  if (imageName == null) return;
  if (typeof imageName !== "string") return;
  if (EMPTY_STATE_IMAGES.has(imageName)) return;
  if (EMPTY_STATE_IMAGE_ALIASES[imageName]) {
    issues.push({
      path,
      rule: "emptystate.imagename-alias",
      severity: "warning",
      message: `EmptyState imageName "${imageName}" was auto-repaired to "${EMPTY_STATE_IMAGE_ALIASES[imageName]}".`,
    });
    return;
  }
  issues.push({
    path,
    rule: "emptystate.imagename-invalid",
    severity: "error",
    message: `EmptyState imageName "${imageName}" is not valid. Fell back to "components".`,
  });
}

function checkTrendDirection(
  node: Record<string, unknown>,
  path: string,
  issues: LintIssue[],
): void {
  if (node.type !== "StatisticsTrend") return;
  const direction = node.direction;
  if (typeof direction !== "string") return;
  if (TREND_DIRECTIONS.has(direction)) return;
  if (TREND_DIRECTION_ALIASES[direction]) {
    issues.push({
      path,
      rule: "trend.direction-alias",
      severity: "warning",
      message: `StatisticsTrend direction "${direction}" was auto-repaired to "${TREND_DIRECTION_ALIASES[direction]}". Valid values: increase, decrease.`,
    });
    return;
  }
  issues.push({
    path,
    rule: "trend.direction-invalid",
    severity: "error",
    message: `StatisticsTrend direction "${direction}" is not valid. Use "increase" or "decrease".`,
  });
}

function checkRestrictiveChildren(
  node: Record<string, unknown>,
  path: string,
  issues: LintIssue[],
): void {
  if (typeof node.type !== "string") return;
  if (!RESTRICTIVE_CHILD_PARENTS.has(node.type)) return;
  const children = node.children;
  const offenders: string[] = [];
  const visit = (child: unknown): void => {
    if (child == null) return;
    if (typeof child === "string") return; // plain text is allowed
    if (!isObject(child)) return;
    if ("$forEach" in child || "$render" in child) return;
    if (typeof child.type !== "string") return;
    if (!RESTRICTIVE_CHILD_ALLOWLIST.has(child.type)) offenders.push(child.type);
  };
  if (Array.isArray(children)) children.forEach(visit);
  else visit(children);
  if (offenders.length > 0) {
    const unique = [...new Set(offenders)];
    issues.push({
      path,
      rule: "button.children-contract",
      severity: "error",
      message: `${node.type} children must be Icon or Text only — found ${unique.join(", ")}.`,
    });
  }
}

function checkIconInText(
  node: Record<string, unknown>,
  path: string,
  parentType: string | null,
  issues: LintIssue[],
): void {
  if (node.type !== "Icon") return;
  if (parentType !== "Text" && parentType !== "StyledText") return;
  issues.push({
    path,
    rule: "icon.nested-in-text",
    severity: "warning",
    message:
      "Icon is nested inside Text. This misaligns the icon and ignores its size prop. Put Icon and Text as siblings in a Flex direction=\"row\" align=\"center\" gap=\"xs\".",
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
