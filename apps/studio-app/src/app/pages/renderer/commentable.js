import { resolve, propsOf } from "./resolve.js";

// Commentable = node types that represent a meaningful design unit a user
// would give feedback on. Leaves (Button, Link, Tag, Icon, Text, form inputs)
// are excluded — comments belong on the enclosing Tile/Statistics/Card/etc.
// Layout plumbing (Flex, Box, AutoGrid) is also excluded.
const COMMENTABLE_TYPES = new Set([
  // Containers that frame content
  "Card",
  "SectionHeader",
  "ButtonRow",
  // Raw Table column headers (DataTable uses its own column comment bar)
  "TableHeader",
  // Data display
  "Statistics",
  "DescriptionList",
  "ProgressBar",
  "ScoreCircle",
  "BarChart",
  "LineChart",
  // DataTable is intentionally NOT here — its column headers are wrapped
  // individually by renderNode in comment mode (one tick per column, inside
  // the header), so a whole-table tick on top of that would be redundant.
  "Kanban",
  "List",
  "KeyValueList",
  "AvatarStack",
  "Image",
  "Illustration",
  // States & alerts
  "EmptyState",
  "ErrorState",
  "Alert",
  // Forms (as whole units)
  "Form",
  "FormBuilder",
  // Grouping affordances
  "Accordion",
  "Tabs",
  "StepIndicator",
  // Overlays (as whole units)
  "Panel",
  "Modal",
  // Typography worth commenting on
  "Heading",
  "StyledText",
  "Text",
  // Actions — label/style feedback is a real use case
  "Button",
  "LoadingButton",
  "Link",
  // Decorative/status leaves
  "Icon",
  "Tag",
  "StatusTag",
  "AutoTag",
  "AutoStatusTag",
  // Form inputs
  "Input",
  "Textarea",
  "TextArea",
  "NumberInput",
  "CurrencyInput",
  "DateInput",
  "TimeInput",
  "StepperInput",
  "SearchInput",
  "Select",
  "MultiSelect",
  "Dropdown",
  "Checkbox",
  "RadioButton",
  "Toggle",
  "ToggleGroup",
]);

// Still tracked so legacy comments on structural nodes render a meaningful
// label in the comments feed via summarizeNode.
const STRUCTURAL_TYPES = new Set(["Flex", "Box", "AutoGrid"]);

// Row-ish parents squeeze their children horizontally, so wrapping a child
// in a CommentTarget (which adds a row with content + dot) breaks the
// intended layout. Skip wrapping inside these.
//
// "DataTable" is included so nodes returned from a column's renderCell
// (e.g. a StatusTag per row) don't each get a tick — table rows aren't a
// comment surface; commenting on a table happens at the column-header level
// (handled by renderNode wrapping each column's `label`).
const ROWISH_PARENTS = new Set(["Inline", "ButtonRow", "DataTable"]);

// Parents that enforce a contract on their children (e.g. "only Icons and
// text allowed inside Buttons"). Wrapping a child in CommentTarget swaps
// the child's type to a host element the parent rejects, producing a
// runtime error in the HubSpot inspector. Skip wrapping inside these
// regardless of child type.
const RESTRICTIVE_CHILD_PARENTS = new Set([
  "Button",
  "LoadingButton",
  "Link",
]);

export function isCommentable(parentType, nodeType, parentDirection) {
  if (parentType === null) return false; // card root is never commentable
  if (!COMMENTABLE_TYPES.has(nodeType)) return false;
  if (ROWISH_PARENTS.has(parentType)) return false;
  if (RESTRICTIVE_CHILD_PARENTS.has(parentType)) return false;
  if (parentType === "Flex" && parentDirection === "row") return false;
  return true;
}

// Structural containers (Flex/Box/Inline) become commentable when the spec
// author tags them with a `name`. Naming a container is an explicit "this is
// a meaningful group" signal — used for the comments-feed label AND to
// promote the group to the comment surface so its descendants don't each
// sprout their own tick.
const NAMEABLE_GROUP_TYPES = new Set(["Flex", "Box", "Inline"]);

export function isNamedGroupCommentable(node, parentType, parentDirection) {
  if (!node || typeof node !== "object") return false;
  if (parentType === null) return false;
  if (!NAMEABLE_GROUP_TYPES.has(node.type)) return false;
  if (RESTRICTIVE_CHILD_PARENTS.has(parentType)) return false;
  if (ROWISH_PARENTS.has(parentType)) return false;
  if (parentType === "Flex" && parentDirection === "row") return false;
  return typeof node.name === "string" && node.name.trim().length > 0;
}

// True when the comment dot should render inline with its content rather than
// in the block layout (dot pushed to the right edge). Currently only raw
// TableHeader cells — the dot belongs inside the header cell next to the
// label, not on the row's far edge. DataTable column headers are handled
// separately via per-column label wrapping in renderNode.
export function isInlineCommentContext(parentType, parentDirection) {
  return parentType === "TableRow";
}

// Skip wrapping a commentable node when it has exactly one rendered child and
// that child chain (through non-commentable wrappers like Flex/Box/Tile)
// reaches another commentable — the inner one provides the comment target,
// so stacking one on the outer produces redundant "1 child, 1 child, 1 child,
// 3 comments" interfaces. With 2+ children we keep the outer (that's where a
// comment on the group belongs).
export function isPassthroughWrapper(node, ctx) {
  if (!node || typeof node !== "object") return false;
  const kids = collectChildNodes(node, ctx);
  if (kids.length !== 1) return false;
  const nextParentType = node.type;
  const nextParentDir =
    node.type === "Flex" ? propsOf(node).direction || null : null;
  return reachesCommentable(kids[0], ctx, nextParentType, nextParentDir);
}

function reachesCommentable(node, ctx, parentType, parentDirection) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") {
    return false;
  }
  if (isCommentable(parentType, node.type, parentDirection)) return true;
  const kids = collectChildNodes(node, ctx);
  if (kids.length !== 1) return false;
  const nextParentType = node.type;
  const nextParentDir =
    node.type === "Flex" ? propsOf(node).direction || null : null;
  return reachesCommentable(kids[0], ctx, nextParentType, nextParentDir);
}

// Best-effort: resolve v1 element ID refs, expand $forEach to its render
// template, filter invisible children. String text children are ignored —
// they can't be comment targets themselves.
function collectChildNodes(node, ctx) {
  const raw = node.children;
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const c of arr) {
    const r = resolveChildNode(c, ctx);
    if (Array.isArray(r)) out.push(...r);
    else if (r) out.push(r);
  }
  return out;
}

function resolveChildNode(child, ctx) {
  if (child == null) return null;
  if (typeof child === "string") {
    if (ctx && ctx.elements && ctx.elements[child]) {
      return resolveChildNode(ctx.elements[child], ctx);
    }
    return null;
  }
  if (typeof child !== "object") return null;
  if (child.$forEach !== undefined) {
    const src = resolve(child.$forEach, ctx);
    if (!Array.isArray(src)) return null;
    const tmpl = child.render;
    if (!tmpl || typeof tmpl !== "object") return null;
    return src.map(() => tmpl);
  }
  if (child.visible !== undefined && !resolve(child.visible, ctx)) return null;
  if (typeof child.type !== "string") return null;
  return child;
}

export function isStructuralContainer(nodeType) {
  return STRUCTURAL_TYPES.has(nodeType);
}

// Short description of a layout container for the outline chip. Prefer
// the spec author's friendly `name` (kebab-case, e.g. "stats-header-group")
// over the computed description so users see a meaningful label.
//   Flex → node.name, else "Flex · column · sm"
//   Box  → node.name, else "Box · flex=1"
//   AutoGrid → node.name, else "AutoGrid · 250px"
export function describeStructure(node) {
  if (!node || typeof node !== "object") return "Node";
  if (typeof node.name === "string" && node.name.trim()) return node.name;

  const type = node.type;
  const props = propsOf(node);

  if (type === "Flex") {
    const parts = ["Flex"];
    if (props.direction) parts.push(props.direction);
    if (props.gap) parts.push(`gap ${props.gap}`);
    return parts.join(" · ");
  }
  if (type === "Box") {
    if (props.flex !== undefined) return `Box · flex=${props.flex}`;
    return "Box";
  }
  if (type === "AutoGrid") {
    if (props.columnWidth) return `AutoGrid · ${props.columnWidth}px`;
    return "AutoGrid";
  }
  return type;
}

// Reference chip text shown in the comment modal + comments feed. For
// structural containers we show the structural description; for everything
// else it's "Type · first-text-found".
export function summarizeNode(node, ctx) {
  if (!node || typeof node !== "object") return "Node";
  if (isStructuralContainer(node.type)) return describeStructure(node);
  const type = node.type || "Node";
  const text = extractText(node, ctx);
  return text ? `${type} · ${text}` : type;
}

const TEXT_PROP_NAMES = ["title", "label", "number", "placeholder"];

function extractText(node, ctx) {
  if (!node || typeof node !== "object") return null;

  for (const k of TEXT_PROP_NAMES) {
    const v = node[k];
    if (v === undefined) continue;
    const r = resolve(v, ctx);
    if (typeof r === "string" && r.trim()) return truncate(r, 40);
  }

  const children = node.children;
  if (typeof children === "string") {
    const r = resolve(children, ctx);
    if (typeof r === "string" && r.trim()) return truncate(r, 40);
  }
  if (Array.isArray(children)) {
    for (const child of children) {
      const t = extractText(child, ctx);
      if (t) return t;
    }
  }

  return null;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}
