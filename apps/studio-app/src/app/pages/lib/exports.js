// Spec → Markdown design doc + TSX starter.
//
// Client-side, pure functions of the spec. No backend round-trip. Outputs are
// "starter" quality: humans will touch them after export. TSX in particular
// best-effort translates expressions and iteration; anything the translator
// can't handle is emitted as a commented placeholder so the file still parses.

// -------- shared helpers -----------------------------------------------------

const indent = (n) => "  ".repeat(n);

// Escape a JS string for embedding in double quotes / template literals.
const jsString = (s) => JSON.stringify(String(s));

const isExpr = (v) =>
  v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).some((k) => k.startsWith("$"));

const isForEach = (v) =>
  v && typeof v === "object" && !Array.isArray(v) && "$forEach" in v;

// Path references ($state.x, $data.x.y, $item.rank) → JS member access.
const refToJs = (ref) => {
  // "$state.foo.bar" → "state.foo.bar"
  const body = ref.slice(1);
  const [head, ...rest] = body.split(".");
  const root =
    head === "state" ? "state" :
    head === "data" ? "data" :
    head; // iteration variable name, used as-is ($item, $mode, ...)
  return rest.length ? `${root}.${rest.join(".")}` : root;
};

// Translate a value that may be a ref-string, template-string, expression,
// iteration, plain literal, or array/object, into a JS expression string.
const valueToJs = (v) => {
  if (v == null) return "null";
  if (typeof v === "string") {
    if (v.startsWith("$")) return refToJs(v);
    if (v.includes("{{")) return templateToJs(v);
    return jsString(v);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return `[${v.map(valueToJs).join(", ")}]`;
  }
  // Action descriptors must be checked before expressions — both start with
  // a $-prefixed key, but actions need to become functions, not value
  // expressions.
  if (isActionDescriptor(v)) return actionToJs(v);
  if (isExpr(v)) return exprToJs(v);
  // Spec-node shaped object — render as JSX element so it behaves like an
  // element when passed as a prop (matches renderer/renderNode.jsx's
  // materializeNodeProp, which turns inline node props into elements).
  if (isSpecNode(v)) return emitNode(v, 0, []);
  // Plain object literal — walk keys, but recursively walk into nested
  // objects so action descriptors / spec nodes nested one level deep still
  // get translated (e.g. { actions: [{ $action: "..." }, ...] }).
  const entries = Object.entries(v).map(
    ([k, val]) => `${jsIdent(k)}: ${valueToJs(val)}`,
  );
  return `{ ${entries.join(", ")} }`;
};

const isSpecNode = (v) =>
  v && typeof v === "object" && !Array.isArray(v) &&
  typeof v.type === "string" &&
  (HS_NAMES.has(v.type) || HSUIX_NAMES.has(v.type));

const jsIdent = (k) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : jsString(k);

// "Day {{item.rank}}: {{item.cause}}" → `` `Day ${item.rank}: ${item.cause}` ``
const templateToJs = (s) => {
  const parts = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("{{", i);
    if (open === -1) {
      parts.push(s.slice(i));
      break;
    }
    if (open > i) parts.push(s.slice(i, open));
    const close = s.indexOf("}}", open);
    if (close === -1) {
      parts.push(s.slice(i));
      break;
    }
    const path = s.slice(open + 2, close).trim();
    parts.push({ expr: refToJs("$" + path) });
    i = close + 2;
  }
  // Emit as template literal.
  const body = parts
    .map((p) =>
      typeof p === "string"
        ? p.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$")
        : `\${${p.expr}}`,
    )
    .join("");
  return `\`${body}\``;
};

const exprToJs = (expr) => {
  const keys = Object.keys(expr);
  const op = keys.find((k) => k.startsWith("$"));
  if (!op) return jsString(JSON.stringify(expr));
  switch (op) {
    case "$eq":  return `(${valueToJs(expr.$eq[0])} === ${valueToJs(expr.$eq[1])})`;
    case "$neq": return `(${valueToJs(expr.$neq[0])} !== ${valueToJs(expr.$neq[1])})`;
    case "$gt":  return `(${valueToJs(expr.$gt[0])} > ${valueToJs(expr.$gt[1])})`;
    case "$lt":  return `(${valueToJs(expr.$lt[0])} < ${valueToJs(expr.$lt[1])})`;
    case "$gte": return `(${valueToJs(expr.$gte[0])} >= ${valueToJs(expr.$gte[1])})`;
    case "$lte": return `(${valueToJs(expr.$lte[0])} <= ${valueToJs(expr.$lte[1])})`;
    case "$and": return `(${expr.$and.map(valueToJs).join(" && ")})`;
    case "$or":  return `(${expr.$or.map(valueToJs).join(" || ")})`;
    case "$not": return `(!${valueToJs(expr.$not)})`;
    case "$if":
      return `(${valueToJs(expr.$if)} ? ${valueToJs(expr.$then)} : ${valueToJs(expr.$else)})`;
    case "$bindState":
      // Read-side expression form. For the full value+onChange pair, emitProps
      // intercepts at the prop level. This case only fires when $bindState is
      // used in an expression context (rare) — just emit the state read.
      return `state.${expr.$bindState}`;
    case "$render": {
      // Lazy render callback. Matches renderer/resolve.js $render: emits a
      // function that takes argNames and renders expr.node with those bound.
      // refToJs naturally turns $value → value, $row.x → row.x, so as long as
      // the JS params match the argNames, refs inside the node resolve.
      const raw = expr.$render;
      const argNames = Array.isArray(raw)
        ? raw
        : [typeof raw === "string" ? raw : "value"];
      const inner = emitNode(expr.node, 2, argNames);
      return `(${argNames.join(", ")}) => (${inner || "null"})`;
    }
    default:
      return `/* unsupported expression: ${op} */ null`;
  }
};

const isActionDescriptor = (v) =>
  v && typeof v === "object" && !Array.isArray(v) && typeof v.$action === "string";

// Emits a handler for the action descriptor. SDK actions assume a
// HubSpot-provided `actions` object is in scope (standard in @hubspot/ui-extensions
// extensions — `hubspot.extend(({ actions }) => ...)`). The starter file wires it.
const actionToJs = (a) => {
  const body = actionBodyJs(a);
  return `() => { ${body} }`;
};

const actionBodyJs = (a) => {
  switch (a.$action) {
    case "setState":
      return `setState((prev) => ({ ...prev, ${jsIdent(a.key)}: ${valueToJs(a.value)} }));`;
    case "batch": {
      const list = Array.isArray(a.actions) ? a.actions : [];
      return list.map(actionBodyJs).join(" ");
    }
    case "addAlert":
      return `actions.addAlert({ title: ${valueToJs(a.title)}, message: ${valueToJs(a.message)}, type: ${valueToJs(a.type || "info")} });`;
    case "copyTextToClipboard":
    case "copyToClipboard":
      return `actions.copyTextToClipboard(${valueToJs(a.value)});`;
    case "closeOverlay":
      return `actions.closeOverlay(${valueToJs(a.id)});`;
    case "openIframeModal":
      return `actions.openIframeModal({ uri: ${valueToJs(a.uri)}, height: ${valueToJs(a.height)}, width: ${valueToJs(a.width)}, title: ${valueToJs(a.title)}, flush: ${valueToJs(a.flush)} });`;
    case "reloadPage":
      return `actions.reloadPage();`;
    case "refreshObjectProperties":
      return `actions.refreshObjectProperties();`;
    default:
      return `/* unsupported action: ${a.$action} */`;
  }
};

// -------- JSX emission -------------------------------------------------------

const PROP_ATTRS_PREFER_INLINE = new Set([
  "label", "title", "name", "variant", "size", "direction", "align", "justify",
  "gap", "padding", "color", "tooltip", "placeholder", "href", "to", "type",
  "disabled", "required", "showLabel",
]);

const emitNode = (node, depth, iterVars) => {
  if (node == null) return "";
  if (typeof node === "string") {
    // String child — template or ref.
    if (node.startsWith("$")) return `{${refToJs(node)}}`;
    if (node.includes("{{")) return `{${templateToJs(node)}}`;
    return escapeJsxText(node);
  }
  if (Array.isArray(node)) {
    return node.map((n) => emitNode(n, depth, iterVars)).join("");
  }
  if (isForEach(node)) return emitForEach(node, depth, iterVars);
  if (node.visible === false) return "";

  const tag = node.type || "Box";
  const props = propsOfNode(node);

  // Conditional render wrapper for node.visible expression.
  let visibleCond = null;
  if (node.visible !== undefined && node.visible !== true) {
    visibleCond = valueToJs(node.visible);
  }

  const propStr = emitProps(props, depth);

  // Children
  let inner = "";
  if (node.children !== undefined) {
    if (typeof node.children === "string") {
      inner = emitNode(node.children, depth + 1, iterVars);
    } else if (Array.isArray(node.children)) {
      inner = node.children
        .map((c) => {
          const rendered = emitNode(c, depth + 1, iterVars);
          return rendered ? `\n${indent(depth + 1)}${rendered}` : "";
        })
        .join("");
      if (inner) inner += `\n${indent(depth)}`;
    } else if (typeof node.children === "object") {
      // Single-node form: children can be a single object rather than an array.
      const rendered = emitNode(node.children, depth + 1, iterVars);
      if (rendered) inner = `\n${indent(depth + 1)}${rendered}\n${indent(depth)}`;
    }
  }

  const open = inner ? `<${tag}${propStr}>` : `<${tag}${propStr} />`;
  const close = inner ? `${inner}</${tag}>` : "";
  const element = `${open}${close}`;

  if (visibleCond) return `{(${visibleCond}) && (${element})}`;
  return element;
};

const isBindMarker = (v) =>
  v && typeof v === "object" && !Array.isArray(v) &&
  typeof v.$bindState === "string";

const emitProps = (props, depth) => {
  const keys = Object.keys(props);
  if (keys.length === 0) return "";
  // First pass: detect $bindState markers. Each produces two emitted props
  // (value + onChange). If the spec already has an explicit onChange, skip
  // the auto-wiring — explicit wins, matching runtime behavior.
  const hasExplicitOnChange = typeof props.onChange !== "undefined" &&
    !isBindMarker(props.onChange);
  const bindingKeys = [];
  const parts = [];
  for (const k of keys) {
    const v = props[k];
    if (isBindMarker(v)) {
      const stateKey = v.$bindState;
      parts.push(`${k}={state.${stateKey}}`);
      if (k !== "onChange") bindingKeys.push(stateKey);
      continue;
    }
    if (typeof v === "string" && !v.startsWith("$") && !v.includes("{{")) {
      parts.push(`${k}=${jsString(v)}`);
      continue;
    }
    if (typeof v === "boolean") {
      parts.push(v ? k : `${k}={false}`);
      continue;
    }
    if (typeof v === "number") {
      parts.push(`${k}={${v}}`);
      continue;
    }
    parts.push(`${k}={${valueToJs(v)}}`);
  }
  // Auto-wire onChange for bound value props — one handler serves at most one
  // bound prop (components with multi-value bindings would need authored
  // onChange). If multiple bindings are present we pick the first; others
  // still render their value but don't get the setter.
  if (!hasExplicitOnChange && bindingKeys.length > 0) {
    const firstKey = bindingKeys[0];
    parts.push(
      `onChange={(_v) => setState((s) => ({ ...s, ${jsIdent(firstKey)}: _v }))}`,
    );
  }
  const inline = ` ${parts.join(" ")}`;
  if (inline.length < 80) return inline;
  return `\n${indent(depth + 1)}${parts.join(`\n${indent(depth + 1)}`)}\n${indent(depth)}`;
};

const emitForEach = (node, depth, iterVars) => {
  const listExpr = valueToJs(node.$forEach);
  const varName = node.as || "item";
  const inner = emitNode(node.render, depth + 2, [...iterVars, varName]);
  return `{(${listExpr} || []).map((${varName}, _i) => (\n${indent(depth + 1)}<React.Fragment key={_i}>${inner}</React.Fragment>\n${indent(depth)}))}`;
};

const escapeJsxText = (s) =>
  s.replace(/[{}]/g, (ch) => `{${jsString(ch)}}`);

// -------- public API ---------------------------------------------------------

// Inline a v1 adjacency-list spec back into a nested tree for emission.
// Lossless under our convention: each element in `elements` is referenced at
// most once from `children`. Shared references would duplicate JSX, but the
// spec shape doesn't produce them.
const inlineV1 = (spec) => {
  if (!spec || typeof spec.root !== "string" || !spec.elements) return spec;
  const elements = spec.elements;
  const expand = (node) => {
    if (node == null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "children") {
        if (Array.isArray(v)) {
          out.children = v.map((c) => {
            if (typeof c === "string" && elements[c]) return expand(elements[c]);
            return c;
          });
        } else if (typeof v === "string" && elements[v]) {
          out.children = expand(elements[v]);
        } else {
          out.children = expand(v);
        }
      } else {
        out[k] = expand(v);
      }
    }
    return out;
  };
  return { ...spec, root: expand(elements[spec.root]) };
};

export const specToTsx = (rawSpec) => {
  if (!rawSpec || typeof rawSpec !== "object") return "";
  const spec = inlineV1(rawSpec);
  const meta = spec.meta || {};
  const state = spec.state || {};
  const data = spec.data || {};
  const root = spec.root;
  const watch = rawSpec.watch && typeof rawSpec.watch === "object" ? rawSpec.watch : null;

  const hsNames = new Set();
  const hsuixNames = new Set();
  collectTypes(root, hsNames, hsuixNames);

  const needsHubspotExtend = true;
  const hsImport = hsNames.size
    ? `import { ${[...hsNames].sort().join(", ")} } from "@hubspot/ui-extensions";`
    : "";
  const hsuixImport = hsuixNames.size
    ? `import { ${[...hsuixNames].sort().join(", ")} } from "hs-uix";`
    : "";
  const extendImport = needsHubspotExtend
    ? `import { hubspot } from "@hubspot/ui-extensions";`
    : "";

  const rootJsx = root ? emitNode(root, 2, []) : "null";
  const watchEffect = watch ? emitWatchEffect(watch) : "";

  return `// Generated by hs-uix Studio. Starter — edit freely.
// Spec: ${meta.name || "(unnamed)"}${meta.surface ? ` · ${meta.surface}` : ""}
//
// Drop this into a HubSpot UI extension's card JSX file. The hubspot.extend
// call at the bottom wires in the \`actions\` object used by addAlert /
// copyTextToClipboard / closeOverlay / openIframeModal / reloadPage /
// refreshObjectProperties.
import React, { useEffect, useRef, useState } from "react";
${extendImport}
${hsImport}
${hsuixImport}

const DATA = ${JSON.stringify(data, null, 2)};

const Extension = ({ actions }) => {
  const [state, setState] = useState(${JSON.stringify(state, null, 2).replace(/\n/g, "\n  ")});
  const data = DATA;
${watchEffect}
  return (
    ${rootJsx}
  );
};

hubspot.extend(({ actions }) => <Extension actions={actions} />);

export default Extension;
`;
};

// Emit a useEffect that mirrors the renderer's watcher semantics: snapshot
// previous state, skip the initial render, fire each declared action when
// its watched key's value changes.
const emitWatchEffect = (watch) => {
  const branches = Object.entries(watch)
    .map(([key, decl]) => {
      const actions = Array.isArray(decl) ? decl : [decl];
      const bodies = actions
        .filter((a) => a && typeof a === "object" && typeof a.$action === "string")
        .map(actionBodyJs)
        .join(" ");
      if (!bodies) return "";
      return `    if (prev[${jsString(key)}] !== state[${jsString(key)}]) { ${bodies} }`;
    })
    .filter(Boolean)
    .join("\n");
  if (!branches) return "";
  return `
  const prevStateRef = useRef(null);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (prev == null) return;
${branches}
  }, [state]);
`;
};

const collectTypes = (node, hs, hsuix) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => collectTypes(n, hs, hsuix));
  if (isForEach(node)) return collectTypes(node.render, hs, hsuix);
  // $render wraps a lazy node — recurse into it so inline cell renderers
  // still contribute to the import list.
  if (node.$render !== undefined && node.node) {
    collectTypes(node.node, hs, hsuix);
  }
  if (typeof node.type === "string") {
    if (HS_NAMES.has(node.type)) hs.add(node.type);
    else if (HSUIX_NAMES.has(node.type)) hsuix.add(node.type);
    // Don't default-bucket unknown type strings — `type: "multiselect"` on
    // a DataTable filter, `type: "success"` on an action descriptor, etc.
    // would otherwise pollute the import list. If the model really emitted
    // a novel component type, the user will see a missing-component error
    // at runtime (catalog validation) and can add the import by hand.
  }
  if (Array.isArray(node.children)) node.children.forEach((c) => collectTypes(c, hs, hsuix));
  else if (node.children && typeof node.children === "object") collectTypes(node.children, hs, hsuix);
  // Walk props for inline spec nodes (e.g. DataTable column.renderCell.node).
  for (const val of Object.values(propsOfNode(node))) collectTypes(val, hs, hsuix);
};

// Mirror of propsOf() in renderer/resolve.js. Duplicated here so the export
// path stays free of a renderer dependency — exports run on saved specs
// without mounting the renderer.
const EXPORT_RESERVED = new Set(["type", "children", "visible", "name"]);
const propsOfNode = (node) => {
  if (!node || typeof node !== "object") return {};
  const out = {};
  // Transitional: accept v0 `node.props` for in-flight rollout. See renderer/resolve.js.
  if (node.props && typeof node.props === "object" && !Array.isArray(node.props)) {
    for (const [k, v] of Object.entries(node.props)) out[k] = v;
  }
  for (const k of Object.keys(node)) {
    if (EXPORT_RESERVED.has(k) || k === "props") continue;
    out[k] = node[k];
  }
  return out;
};

// Mirrors apps/studio-app/src/app/pages/renderer/components.js.
const HS_NAMES = new Set([
  "Accordion","Alert","AutoGrid","BarChart","Box","Button","ButtonRow","Card",
  "Checkbox","CurrencyInput","DateInput","DescriptionList","DescriptionListItem",
  "Divider","Dropdown","EmptyState","ErrorState","Flex","Form","Heading","Icon",
  "Illustration","Image","Inline","Input","LineChart","Link","List",
  "LoadingButton","LoadingSpinner","Modal","ModalBody","ModalFooter","MultiSelect",
  "NumberInput","Panel","PanelBody","PanelFooter","PanelSection","ProgressBar",
  "RadioButton","ScoreCircle","SearchInput","Select","Spacer","Stack","Statistics",
  "StatisticsItem","StatisticsTrend","StatusTag","StepIndicator","StepperInput",
  "Tab","Table","TableBody","TableCell","TableFooter","TableHead","TableHeader",
  "TableRow","Tabs","Tag","Text","TextArea","Textarea","Tile","TimeInput","Toggle",
  "ToggleGroup","Tooltip",
]);
const HSUIX_NAMES = new Set([
  "DataTable","Kanban","KanbanCardActions","FormBuilder","AutoTag","AutoStatusTag",
  "KeyValueList","SectionHeader","AvatarStack","StyledText",
]);

// -------- markdown -----------------------------------------------------------

export const specToMarkdown = (rawSpec) => {
  if (!rawSpec || typeof rawSpec !== "object") return "";
  const spec = inlineV1(rawSpec);
  const meta = spec.meta || {};
  const state = spec.state || {};
  const data = spec.data || {};

  const lines = [];
  lines.push(`# ${meta.name || "Untitled card"}`);
  lines.push("");
  if (meta.description) lines.push(meta.description, "");

  lines.push("## Surface");
  lines.push("");
  lines.push(`- **Surface:** \`${meta.surface || "(unspecified)"}\``);
  if (meta.object) lines.push(`- **Object:** \`${meta.object}\``);
  lines.push("");

  if (Object.keys(state).length) {
    lines.push("## State");
    lines.push("");
    lines.push("Mutable values toggled from the UI:");
    lines.push("");
    for (const [k, v] of Object.entries(state)) {
      lines.push(`- \`${k}\` — initial: \`${JSON.stringify(v)}\``);
    }
    lines.push("");
  }

  if (Object.keys(data).length) {
    lines.push("## Data");
    lines.push("");
    lines.push("Pre-computed values consumed by the card. In production this comes from a serverless function.");
    lines.push("");
    for (const [k, v] of Object.entries(data)) {
      const preview = previewValue(v);
      lines.push(`- \`${k}\` — ${preview}`);
    }
    lines.push("");
  }

  lines.push("## Structure");
  lines.push("");
  lines.push("```");
  renderOutline(spec.root, 0, lines);
  lines.push("```");
  lines.push("");

  return lines.join("\n");
};

const previewValue = (v) => {
  if (v == null) return "`null`";
  if (Array.isArray(v)) return `array of ${v.length}`;
  if (typeof v === "object") return `object (${Object.keys(v).length} keys)`;
  const s = JSON.stringify(v);
  return s.length > 60 ? `\`${s.slice(0, 57)}...\`` : `\`${s}\``;
};

const renderOutline = (node, depth, out) => {
  if (!node || typeof node !== "object") return;
  if (isForEach(node)) {
    out.push(`${indent(depth)}• forEach ${node.$forEach} as ${node.as || "item"}`);
    renderOutline(node.render, depth + 1, out);
    return;
  }
  const label = node.name ? `${node.type} "${node.name}"` : node.type;
  out.push(`${indent(depth)}• ${label}`);
  if (Array.isArray(node.children)) {
    node.children.forEach((c) => renderOutline(c, depth + 1, out));
  } else if (typeof node.children === "string") {
    const preview = node.children.length > 40 ? node.children.slice(0, 37) + "..." : node.children;
    out.push(`${indent(depth + 1)}  └ "${preview}"`);
  }
};
