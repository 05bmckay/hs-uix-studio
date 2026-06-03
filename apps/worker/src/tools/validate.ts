// validate_spec — dry-runs the renderer against a candidate spec. Returns
// structured errors without producing React output. Used to catch common
// Studio-emits-garbage failure modes before the client renders:
//
//   - Unknown component type (checked against src/catalog.ts)
//   - Unknown or malformed $action descriptor
//   - Missing required `type` field on a node
//   - Broken adjacency list (root ID not in elements, missing children IDs)
//   - Wrong-shape children / expression objects
//
// v1 shape: { root: "<id>", elements: { id: node, ... } }. Back-compat for v0
// nested trees is intentionally NOT preserved here — callers should migrate
// specs before validating.

import { COMPONENT_NAMES, ACTIONS, ACTION_KINDS } from "../catalog.js";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export function validateSpec(spec: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isObject(spec)) {
    return { ok: false, errors: [{ path: "$", message: "spec must be a JSON object" }] };
  }
  if (typeof spec.root !== "string") {
    errors.push({ path: "$.root", message: "spec.root must be a string ID (use the v1 adjacency-list shape)" });
    return { ok: false, errors };
  }
  if (!isObject(spec.elements)) {
    errors.push({ path: "$.elements", message: "spec.elements must be an object map of id → node" });
    return { ok: false, errors };
  }
  const elements = spec.elements as Record<string, unknown>;
  if (!(spec.root in elements)) {
    errors.push({ path: "$.root", message: `root id "${spec.root}" not found in elements` });
  }

  const visited = new Set<string>();
  const walk = (id: string, path: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = elements[id];
    if (!isObject(node)) {
      errors.push({ path, message: `elements["${id}"] must be an object` });
      return;
    }
    walkNode(node, `${path}`, errors, elements, walk);
  };
  if (typeof spec.root === "string" && spec.root in elements) {
    walk(spec.root, `$.elements["${spec.root}"]`);
  }

  // Dangling elements (in the map but unreachable from root) are flagged as
  // info-level but don't fail validation — useful during iterative editing.
  for (const id of Object.keys(elements)) {
    if (!visited.has(id)) {
      errors.push({ path: `$.elements["${id}"]`, message: `unreachable from root — orphan element` });
    }
  }

  return { ok: errors.filter((e) => !e.message.includes("orphan element")).length === 0, errors };
}

function walkNode(
  node: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
  elements: Record<string, unknown>,
  walkId: (id: string, path: string) => void,
): void {
  // Inline templates: $forEach (children array) or $render (lazy callback).
  if ("$forEach" in node) {
    if (typeof node.$forEach !== "string") {
      errors.push({ path, message: "$forEach must be a string reference like '$data.items'" });
    }
    if (!("render" in node) || !isObject(node.render)) {
      errors.push({ path, message: "$forEach must include a render node" });
    } else {
      walkNode(node.render as Record<string, unknown>, `${path}.render`, errors, elements, walkId);
    }
    return;
  }
  if ("$render" in node) {
    if (!("node" in node) || !isObject(node.node)) {
      errors.push({ path, message: "$render must include a node" });
    } else {
      walkNode(node.node as Record<string, unknown>, `${path}.node`, errors, elements, walkId);
    }
    return;
  }

  if (typeof node.type !== "string") {
    errors.push({ path, message: "node.type is required and must be a string" });
    return;
  }
  if (!COMPONENT_NAMES.has(node.type)) {
    errors.push({
      path,
      message: `unknown component "${node.type}" — not in the catalog`,
    });
  }

  // Icon.name is required by the platform — missing it renders blank.
  // repair.ts will replace it with an xCircle placeholder, but we also
  // flag it so the model sees the mistake on the same turn.
  if (node.type === "Icon" && typeof node.name !== "string") {
    errors.push({
      path,
      message:
        "Icon requires a `name` prop (a catalog icon name). There is no default glyph — see media.md for valid names.",
    });
  }

  // Action descriptors on event-handler props.
  for (const [key, val] of Object.entries(node)) {
    if (key === "children" || key === "type" || key === "name" || key === "visible") continue;
    checkActionValue(val, `${path}.${key}`, errors);
  }

  const children = node.children;
  if (children == null) return;
  if (typeof children === "string") {
    // Either a text leaf or an element ID. If it looks like an ID, recurse.
    if (children in elements) {
      walkId(children, `$.elements["${children}"]`);
    }
    return;
  }
  if (Array.isArray(children)) {
    children.forEach((child, i) => {
      if (typeof child === "string") {
        if (child in elements) walkId(child, `$.elements["${child}"]`);
        // Otherwise text/template — not validated further.
        return;
      }
      if (isObject(child)) {
        walkNode(child as Record<string, unknown>, `${path}.children[${i}]`, errors, elements, walkId);
        return;
      }
      errors.push({
        path: `${path}.children[${i}]`,
        message: "child must be an element ID, text string, or inline node",
      });
    });
    return;
  }
  if (isObject(children)) {
    walkNode(children as Record<string, unknown>, `${path}.children`, errors, elements, walkId);
    return;
  }
  errors.push({
    path: `${path}.children`,
    message: "children must be an array, string, or single node object",
  });
}

// Recursively check any value for $action descriptors and validate their
// shape against the action catalog. Non-action values pass through.
function checkActionValue(val: unknown, path: string, errors: ValidationError[]): void {
  if (!val || typeof val !== "object") return;
  if (Array.isArray(val)) {
    val.forEach((v, i) => checkActionValue(v, `${path}[${i}]`, errors));
    return;
  }
  const obj = val as Record<string, unknown>;
  if ("$action" in obj) {
    const kind = obj.$action;
    if (typeof kind !== "string") {
      errors.push({ path, message: "$action must be a string kind" });
      return;
    }
    if (!ACTION_KINDS.has(kind)) {
      errors.push({ path, message: `unknown action "${kind}" — not in the action catalog` });
      return;
    }
    const def = ACTIONS[kind as keyof typeof ACTIONS];
    const { $action, ...params } = obj;
    const result = def.params.safeParse(params);
    if (!result.success) {
      const issue = result.error.issues[0];
      errors.push({
        path,
        message: `action "${kind}" params invalid: ${issue.path.join(".")} ${issue.message}`,
      });
    }
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    checkActionValue(v, `${path}.${k}`, errors);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
