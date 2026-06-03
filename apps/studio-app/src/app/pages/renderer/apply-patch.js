// RFC 6902 JSON Patch applier — minimal subset used by Phase-2 patch
// streaming. Operates on a spec object shaped like:
//   { meta, state, data, root: "<id>", elements: { id: node, ... } }
//
// Supported ops: add, replace, remove, move, copy (skipping `test`).
//
// Returns a NEW spec object (structural sharing where safe). Never mutates
// input — Canvas relies on reference equality to detect updates.
//
// Intentionally permissive: if a path prefix is missing, `add` creates it.
// This matches the worker-side emit-flow where the shell (`/meta`, `/state`,
// etc.) may arrive before `/elements`.

export function applyPatches(spec, patches) {
  if (!patches || patches.length === 0) return spec;
  let out = spec ?? {};
  for (const op of patches) {
    out = applyOne(out, op);
  }
  return out;
}

function applyOne(spec, op) {
  const path = parsePointer(op.path);
  switch (op.op) {
    case "add":
    case "replace":
      return setAt(spec, path, op.value);
    case "remove":
      return removeAt(spec, path);
    case "move": {
      const from = parsePointer(op.from);
      const value = getAt(spec, from);
      const removed = removeAt(spec, from);
      return setAt(removed, path, value);
    }
    case "copy": {
      const from = parsePointer(op.from);
      const value = getAt(spec, from);
      return setAt(spec, path, deepClone(value));
    }
    default:
      console.warn("[applyPatches] ignoring unsupported op:", op.op);
      return spec;
  }
}

// ---------------------------------------------------------------------------

function parsePointer(pointer) {
  if (!pointer || pointer === "/") return [];
  if (pointer[0] !== "/") {
    throw new Error(`invalid JSON Pointer (must start with /): ${pointer}`);
  }
  // Split on "/", then unescape each segment.
  return pointer
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getAt(obj, segs) {
  let cur = obj;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}

function setAt(obj, segs, value) {
  if (segs.length === 0) return value;
  const [head, ...rest] = segs;
  const isArray = Array.isArray(obj);
  if (isArray) {
    const next = obj.slice();
    const idx = head === "-" ? next.length : Number(head);
    const existing = idx >= 0 && idx < next.length ? next[idx] : undefined;
    const child = setAt(existing ?? {}, rest, value);
    if (rest.length === 0) {
      // Insert (for "-") vs replace.
      if (head === "-") next.push(value);
      else next[idx] = value;
    } else {
      next[idx] = child;
    }
    return next;
  }
  // Object
  const base = obj && typeof obj === "object" ? obj : {};
  if (rest.length === 0) {
    return { ...base, [head]: value };
  }
  const existing = base[head];
  const child = setAt(existing ?? (looksLikeArrayIndex(rest[0]) ? [] : {}), rest, value);
  return { ...base, [head]: child };
}

function removeAt(obj, segs) {
  if (segs.length === 0) return undefined;
  const [head, ...rest] = segs;
  if (Array.isArray(obj)) {
    const next = obj.slice();
    const idx = Number(head);
    if (rest.length === 0) {
      next.splice(idx, 1);
    } else {
      next[idx] = removeAt(next[idx], rest);
    }
    return next;
  }
  if (!obj || typeof obj !== "object") return obj;
  if (rest.length === 0) {
    const next = { ...obj };
    delete next[head];
    return next;
  }
  if (!(head in obj)) return obj;
  return { ...obj, [head]: removeAt(obj[head], rest) };
}

function looksLikeArrayIndex(seg) {
  return seg === "-" || /^\d+$/.test(seg);
}

function deepClone(v) {
  // Fine for our spec shapes — no Date/Map/Set etc.
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
