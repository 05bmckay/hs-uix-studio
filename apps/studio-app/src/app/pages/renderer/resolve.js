// Spec expression evaluation.
//
//   resolve(value, ctx)  →  evaluates one value against ctx
//   resolveProps(props, ctx)  →  evaluates prop object, converting $action
//                                 descriptors into functions
//
// ctx shape: { state, data, setState, ...iterationVars }
//
// Grammar (see specs/README.md):
//   "$path.to.value"     bare reference (any type)
//   "literal {{path}}"   template interpolation (string output)
//   { $op: [...] }       expression object
//   { $action: ... }     action descriptor (only valid as a prop value)
//   { $render: "name",   lazy render — emits a marker that materializeNodeProp
//     node: { ... } }    converts to (arg) => renderNode(node, ctx with `name`
//                        bound to arg). Used for callback props that take a
//                        row/item argument (DataTable column.renderCell, etc.)

import { makeAction } from "./actions.js";

// Structural keys reserved on a spec node. Anything not in this set is a
// component prop — props are hoisted to the node's top level rather than
// nested under a `props` object. See specs/README.md for the full shape.
//
// `name` is reserved because spec authors use it as a friendly identifier
// for comment summaries (e.g. `{type:"Flex", name:"page-header"}`). But for
// a handful of components it's ALSO the platform's required prop —
// collision. The TYPES_WITH_NAME_PROP set lets `name` pass through as a
// component prop for those types.
const RESERVED_KEYS = new Set(["type", "children", "visible", "name"]);

// Components where `name` is a real component prop, not just an author
// label. For these, we stop treating `name` as a structural key. The
// comment-outline label falls back to `describeStructure` (type + friendly
// summary) since we've given the name back to the component.
const TYPES_WITH_NAME_PROP = new Set([
  "Icon",
  "Input",
  "Checkbox",
  "RadioButton",
  "NumberInput",
  "CurrencyInput",
  "DateInput",
  "TimeInput",
  "StepperInput",
  "SearchInput",
  "TextArea",
  "Textarea",
  "Select",
  "MultiSelect",
  "Dropdown",
  "Toggle",
  "ToggleGroup",
  "Tab",
]);

export function propsOf(node) {
  if (!node || typeof node !== "object") return {};
  const out = {};
  const nameIsProp = TYPES_WITH_NAME_PROP.has(node.type);
  // Transitional: v0 nodes nested props under `node.props`. Merge them in
  // (hoisted keys win on conflict). Safe to delete once the deployed worker
  // and any persisted specs are known to be on the v1 hoisted shape.
  if (node.props && typeof node.props === "object" && !Array.isArray(node.props)) {
    for (const [k, v] of Object.entries(node.props)) out[k] = v;
  }
  for (const k of Object.keys(node)) {
    if (k === "props") continue;
    if (RESERVED_KEYS.has(k)) {
      if (k === "name" && nameIsProp) {
        out[k] = node[k];
      }
      continue;
    }
    out[k] = node[k];
  }
  return out;
}

export function resolve(value, ctx) {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (isReferenceString(value)) {
      return resolvePath(value.slice(1), ctx);
    }
    if (value.includes("{{")) {
      return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
        const v = resolvePath(path, ctx);
        return v === undefined || v === null ? "" : String(v);
      });
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolve(v, ctx));
  }

  if (typeof value === "object") {
    const exprKey = findExprKey(value);
    if (exprKey) return OPERATORS[exprKey](value, ctx);

    const out = {};
    for (const k of Object.keys(value)) out[k] = resolve(value[k], ctx);
    return out;
  }

  return value;
}

export function resolveProps(props, ctx) {
  if (!props) return {};
  const out = {};
  for (const [key, value] of Object.entries(props)) {
    if (isActionDescriptor(value)) {
      out[key] = makeAction(value, ctx);
    } else {
      out[key] = resolve(value, ctx);
    }
  }
  return out;
}

function isReferenceString(value) {
  // `$data.foo`, `$state.view`, `$item.label`, `$row.amount`, or any
  // iteration variable like `$deal.name`. Currency literals such as
  // "$1,240,000" must stay plain strings for props like StatisticsItem.number.
  if (!value.startsWith("$") || value.startsWith("${") || value.includes(" ")) {
    return false;
  }
  return /^\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(value);
}

function resolvePath(path, ctx) {
  const segments = path.split(".");
  let value = ctx[segments[0]];
  for (let i = 1; i < segments.length && value !== undefined && value !== null; i++) {
    value = value[segments[i]];
  }
  return value;
}

function isActionDescriptor(v) {
  return v && typeof v === "object" && !Array.isArray(v) && "$action" in v;
}

function findExprKey(obj) {
  for (const k of Object.keys(obj)) {
    if (k.startsWith("$") && OPERATORS[k]) return k;
  }
  return null;
}

const OPERATORS = {
  $eq: (n, ctx) => {
    const [a, b] = n.$eq.map((v) => resolve(v, ctx));
    return a === b;
  },
  $neq: (n, ctx) => {
    const [a, b] = n.$neq.map((v) => resolve(v, ctx));
    return a !== b;
  },
  $gt: (n, ctx) => {
    const [a, b] = n.$gt.map((v) => resolve(v, ctx));
    return a > b;
  },
  $lt: (n, ctx) => {
    const [a, b] = n.$lt.map((v) => resolve(v, ctx));
    return a < b;
  },
  $gte: (n, ctx) => {
    const [a, b] = n.$gte.map((v) => resolve(v, ctx));
    return a >= b;
  },
  $lte: (n, ctx) => {
    const [a, b] = n.$lte.map((v) => resolve(v, ctx));
    return a <= b;
  },
  $and: (n, ctx) => n.$and.every((v) => !!resolve(v, ctx)),
  $or: (n, ctx) => n.$or.some((v) => !!resolve(v, ctx)),
  $not: (n, ctx) => !resolve(n.$not, ctx),
  $if: (n, ctx) => {
    const cond = resolve(n.$if, ctx);
    return cond ? resolve(n.$then, ctx) : resolve(n.$else, ctx);
  },
  // Returns a sentinel that materializeNodeProp recognizes and turns into a
  // function. We deliberately do NOT recurse into n.node here — it would
  // eagerly try to resolve $row.* against an undefined `row` (which only
  // gets bound when the host component invokes the callback).
  //
  // $render accepts a single name ("value") for one-arg callbacks, or an
  // array (["value", "row"]) for multi-arg callbacks like DataTable's
  // renderCell(value, row). Each name binds the corresponding positional arg.
  $render: (n) => {
    const raw = n.$render;
    const argNames = Array.isArray(raw)
      ? raw
      : [typeof raw === "string" ? raw : "value"];
    return { __isRenderMarker: true, argNames, node: n.node };
  },

  // Two-way input binding. `{ "$bindState": "viewMode" }` on a value prop
  // resolves to state.viewMode AND causes renderNode to emit a matching
  // onChange handler that fires ctx.setState("viewMode", v) when the input
  // reports a change. Eliminates the `$event`/defaultValue workaround for
  // standard HubSpot inputs (Input, Select, TextArea, NumberInput, etc.).
  //
  // v1: flat top-level state keys only. Dotted paths like "form.email" would
  // require setState to understand nested paths — simpler to flatten state
  // for now and revisit if specs routinely need nesting.
  $bindState: (n, ctx) => {
    const key = n.$bindState;
    const current = ctx.state ? ctx.state[key] : undefined;
    return { __isBindMarker: true, kind: "state", key, current };
  },

  $add: (n, ctx) => n.$add.reduce((a, v) => a + Number(resolve(v, ctx)), 0),
  $sub: (n, ctx) => {
    const args = n.$sub.map((v) => Number(resolve(v, ctx)));
    return args.slice(1).reduce((a, b) => a - b, args[0]);
  },
  $mul: (n, ctx) => n.$mul.reduce((a, v) => a * Number(resolve(v, ctx)), 1),
  $div: (n, ctx) => {
    const args = n.$div.map((v) => Number(resolve(v, ctx)));
    return args.slice(1).reduce((a, b) => a / b, args[0]);
  },
  $mod: (n, ctx) => {
    const [a, b] = n.$mod.map((v) => Number(resolve(v, ctx)));
    return a % b;
  },
  $min: (n, ctx) => Math.min(...n.$min.map((v) => Number(resolve(v, ctx)))),
  $max: (n, ctx) => Math.max(...n.$max.map((v) => Number(resolve(v, ctx)))),

  $length: (n, ctx) => {
    const v = resolve(n.$length, ctx);
    return v == null ? 0 : v.length ?? 0;
  },
  // $slice: [source, start] or [source, start, end]. Works on arrays and
  // strings; mirrors Array.prototype.slice / String.prototype.slice.
  $slice: (n, ctx) => {
    const [src, start, end] = n.$slice.map((v) => resolve(v, ctx));
    if (src == null || typeof src.slice !== "function") return [];
    return end === undefined ? src.slice(start) : src.slice(start, end);
  },
  // $concat: [a, b, ...]. If first arg is an array, concatenates arrays;
  // otherwise joins as strings.
  $concat: (n, ctx) => {
    const args = n.$concat.map((v) => resolve(v, ctx));
    if (Array.isArray(args[0])) {
      return args.reduce((a, b) => a.concat(b ?? []), []);
    }
    return args.map((v) => (v == null ? "" : String(v))).join("");
  },
  $includes: (n, ctx) => {
    const [src, item] = n.$includes.map((v) => resolve(v, ctx));
    if (src == null || typeof src.includes !== "function") return false;
    return src.includes(item);
  },
  // $coalesce: returns first non-null/undefined arg. Useful for defaults.
  $coalesce: (n, ctx) => {
    for (const v of n.$coalesce) {
      const r = resolve(v, ctx);
      if (r !== null && r !== undefined) return r;
    }
    return undefined;
  },
};
