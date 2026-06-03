import React from "react";
import { components } from "./components.js";
import { resolve, resolveProps, propsOf } from "./resolve.js";
import { makeAction } from "./actions.js";
import {
  isCommentable,
  isInlineCommentContext,
  isNamedGroupCommentable,
  isPassthroughWrapper,
  summarizeNode,
} from "./commentable.js";
import { CommentTarget, InlineCommentTarget } from "./CommentTarget.jsx";

// Recursive render dispatch. `info` carries per-location context needed for
// comment targeting: the node's stable path-ID, its parent component type,
// and — for Flex parents — the parent's direction so we can skip wrapping
// children of row-oriented containers (which would get squeezed).
const ROOT_INFO = { path: "root", parentType: null, parentDirection: null };

export function renderNode(node, ctx, info = ROOT_INFO) {
  if (node === null || node === undefined) return null;

  if (typeof node === "string") return resolve(node, ctx);
  if (typeof node === "number" || typeof node === "boolean") return node;

  if (node.$forEach !== undefined) {
    const resolvedSource = resolve(node.$forEach, ctx);
    const source = Array.isArray(resolvedSource) ? resolvedSource : [];
    if (resolvedSource != null && !Array.isArray(resolvedSource)) {
      console.warn(
        `[Canvas] $forEach expected an array at ${info.path}; received ${typeof resolvedSource}.`,
      );
    }
    const varName = node.as || "item";
    return source.map((item, idx) => {
      const iterCtx = { ...ctx, [varName]: item };
      const iterInfo = {
        path: `${info.path}.foreach[${idx}]`,
        parentType: info.parentType,
        parentDirection: info.parentDirection,
      };
      const rendered = renderNode(node.render, iterCtx, iterInfo);
      if (React.isValidElement(rendered) && rendered.key == null) {
        return React.cloneElement(rendered, { key: idx });
      }
      return rendered;
    });
  }

  if (node.visible !== undefined) {
    const shouldRender = resolve(node.visible, ctx);
    if (!shouldRender) return null;
  }

  if (!node.type) return null;

  const Component = components[node.type];
  if (!Component) {
    // Previously returned null silently — spec authors would miss typos until
    // a whole region disappeared. Render a visible inline placeholder and
    // keep the warning so it also shows up in devtools.
    console.warn(`[Canvas] Unknown component type: ${node.type}`);
    return (
      <components.Alert
        variant="warning"
        title={`Unknown component: ${node.type}`}
      >
        Spec referenced a component the renderer doesn't know. Check for typos
        or add the component to the catalog.
      </components.Alert>
    );
  }

  const props = resolveProps(propsOf(node), ctx);
  for (const key of Object.keys(props)) {
    props[key] = materializeNodeProp(props[key], ctx, {
      path: `${info.path}.props.${key}`,
      parentType: node.type,
      parentDirection: null,
    });
  }
  // $bindState expansion: a resolved prop whose value is a bind marker gets
  // replaced with its current value, and a companion onChange handler is
  // injected that writes back via setState. An explicit onChange wins — if
  // the spec already set one, we don't overwrite it.
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (v && typeof v === "object" && v.__isBindMarker) {
      props[key] = v.current;
      if (v.kind === "state" && typeof props.onChange !== "function") {
        const bindKey = v.key;
        props.onChange = (value) => ctx.setState(bindKey, value);
      }
    }
  }
  const namedGroup = isNamedGroupCommentable(
    node,
    info.parentType,
    info.parentDirection,
  );
  const childInfo = {
    path: info.path,
    parentType: node.type,
    parentDirection: node.type === "Flex" ? props.direction || null : null,
  };
  const children = renderChildren(node.children, ctx, childInfo);

  // DataTable doesn't expose its column headers as children — they live on
  // the `columns` prop. In comment mode, wrap each column's label so every
  // header gets one tick rendered inside the header cell instead of a single
  // whole-table tick on the right.
  if (
    node.type === "DataTable" &&
    ctx.commentMode &&
    Array.isArray(props.columns)
  ) {
    props.columns = props.columns.map((col, idx) => {
      if (!col || typeof col !== "object") return col;
      const colId = `${info.path}.columns[${col.field || idx}]`;
      const labelText =
        typeof col.label === "string" ? col.label : col.field || `Column ${idx + 1}`;
      return {
        ...col,
        label: (
          <InlineCommentTarget
            nodeId={colId}
            nodeSummary={`Column · ${labelText}`}
            onAddComment={ctx.onAddComment}
          >
            {col.label}
          </InlineCommentTarget>
        ),
      };
    });
  }

  let element = <Component {...props}>{children}</Component>;

  // HubSpot's Tabs caches inactive tab children at mount and never re-renders
  // them when parent state changes — so a Tab whose body depends on $state.x
  // shows stale content until the user clicks it. Walk this Tab's subtree,
  // collect referenced state keys (skipping $bindState two-way bindings to
  // avoid remounting controlled inputs on every keystroke), and key the Tab
  // on the current values. Inactive tabs remount when their dependencies
  // change; active tabs remount once when state first transitions.
  if (node.type === "Tab") {
    const stateKeys = collectTabStateKeys(node, ctx);
    if (stateKeys.size > 0) {
      const parts = [];
      const sorted = Array.from(stateKeys).sort();
      for (const k of sorted) {
        const v = ctx.state?.[k];
        parts.push(
          `${k}:${
            v && typeof v === "object" ? JSON.stringify(v) : String(v)
          }`,
        );
      }
      element = React.cloneElement(element, { key: parts.join("|") });
    }
  }

  if (!ctx.commentMode) return element;

  const isLeafCommentable = isCommentable(
    info.parentType,
    node.type,
    info.parentDirection,
  );
  // Named groups beat passthrough collapsing: the explicit name *is* the
  // signal that this node — not some descendant chain — is the comment unit.
  const skipForPassthrough =
    isLeafCommentable && !namedGroup && isPassthroughWrapper(node, ctx);

  if ((!isLeafCommentable && !namedGroup) || skipForPassthrough) {
    return element;
  }

  const summary = summarizeNode(node, ctx);
  const Target = isInlineCommentContext(info.parentType, info.parentDirection)
    ? InlineCommentTarget
    : CommentTarget;
  return (
    <Target
      nodeId={info.path}
      nodeSummary={summary}
      onAddComment={ctx.onAddComment}
      dotColor={namedGroup ? "success" : "inherit"}
    >
      {element}
    </Target>
  );
}

// Resolve a child entry to either a node (for renderNode) or a primitive
// (string/number/etc.) for direct output. In v1, a string entry may be an
// element ID — if ctx.elements has it, we swap in the referenced node and
// update the info.path so comments anchor against the stable ID rather than
// the positional path. Otherwise the string is treated as text/template/ref.
function resolveChildEntry(child, ctx, info) {
  if (typeof child === "string" && ctx.elements && ctx.elements[child]) {
    return {
      node: ctx.elements[child],
      info: { ...info, path: `elements.${child}` },
    };
  }
  return { node: child, info };
}

function renderChildren(children, ctx, info) {
  if (children === undefined || children === null) return undefined;

  if (!Array.isArray(children)) {
    const single = resolveChildEntry(children, ctx, {
      ...info,
      path: `${info.path}.children[0]`,
    });
    return renderNode(single.node, ctx, single.info);
  }

  const out = [];
  let key = 0;
  children.forEach((child, idx) => {
    const positional = { ...info, path: `${info.path}.children[${idx}]` };
    const { node, info: childInfo } = resolveChildEntry(child, ctx, positional);
    const r = renderNode(node, ctx, childInfo);
    if (Array.isArray(r)) {
      for (const el of r) out.push(keyed(el, key++));
    } else {
      out.push(keyed(r, key++));
    }
  });
  return out;
}

// A prop value that looks like a spec node — has a string `type` that the
// renderer knows — gets rendered to an element. Arrays of such values are
// mapped. $render markers (from the $render expression operator) are
// converted into functions that bind their argument and render lazily.
//
// Plain objects are walked one level deep so nested $render markers (e.g.
// inside a DataTable column's `renderCell` field) get found. The deep walk
// only mutates when something actually changes — no allocations for
// passthrough objects like `{ format: { fontWeight: "bold" } }`.
function materializeNodeProp(value, ctx, info) {
  return walkProp(value, ctx, info, true);
}

function walkProp(value, ctx, info, isTop) {
  if (React.isValidElement(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    value.__isRenderMarker === true
  ) {
    return (...args) => {
      const callCtx = { ...ctx };
      value.argNames.forEach((name, i) => {
        if (typeof name === "string") callCtx[name] = args[i];
      });
      if (
        value.node &&
        typeof value.node === "object" &&
        "$action" in value.node
      ) {
        return makeAction(value.node, callCtx)(...args);
      }
      return renderNode(value.node, callCtx, info);
    };
  }
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      walkProp(v, ctx, { ...info, path: `${info.path}[${i}]` }, true),
    );
  }
  if (
    value &&
    typeof value === "object" &&
    isTop &&
    typeof value.type === "string" &&
    components[value.type]
  ) {
    return renderNode(value, ctx, info);
  }
  if (value && typeof value === "object") {
    let mutated = false;
    const out = {};
    for (const k of Object.keys(value)) {
      const v = walkProp(
        value[k],
        ctx,
        { ...info, path: `${info.path}.${k}` },
        false,
      );
      if (v !== value[k]) mutated = true;
      out[k] = v;
    }
    return mutated ? out : value;
  }
  return value;
}

// Walks a Tab subtree looking for $state.x references — both bare ("$state.x")
// and template-interpolated ("{{state.x}}") — so we can key the Tab on the
// values of just the state slots its content actually depends on. Follows v1
// element-ID children into ctx.elements with a `seen` guard against cycles.
// Skips $bindState (controlled-input two-way binding) so typing into an Input
// inside the tab doesn't churn its key on every keystroke.
function collectTabStateKeys(node, ctx) {
  const keys = new Set();
  const seen = new Set();
  walkForStateKeys(node, ctx, seen, keys);
  return keys;
}

function walkForStateKeys(value, ctx, seen, keys) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.startsWith("$state.")) {
      const path = value.slice("$state.".length);
      const head = path.split(".")[0];
      if (head) keys.add(head);
      return;
    }
    if (value.includes("{{")) {
      const re = /\{\{\s*state\.([A-Za-z0-9_]+)/g;
      let m;
      while ((m = re.exec(value)) !== null) keys.add(m[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkForStateKeys(v, ctx, seen, keys);
    return;
  }
  if (typeof value !== "object") return;
  // $bindState is the controlled-input binding — skip its referenced key so
  // typing in an Input doesn't remount the Tab. Other $-keys (operators) walk
  // normally.
  for (const k of Object.keys(value)) {
    if (k === "$bindState") continue;
    const child = value[k];
    if (k === "children") {
      if (Array.isArray(child)) {
        for (const c of child) walkChildEntry(c, ctx, seen, keys);
      } else {
        walkChildEntry(child, ctx, seen, keys);
      }
    } else {
      walkForStateKeys(child, ctx, seen, keys);
    }
  }
}

function walkChildEntry(child, ctx, seen, keys) {
  if (typeof child === "string" && ctx.elements && ctx.elements[child]) {
    if (seen.has(child)) return;
    seen.add(child);
    walkForStateKeys(ctx.elements[child], ctx, seen, keys);
    return;
  }
  walkForStateKeys(child, ctx, seen, keys);
}

function keyed(el, fallbackKey) {
  if (React.isValidElement(el) && el.key == null) {
    return React.cloneElement(el, { key: fallbackKey });
  }
  return el;
}
