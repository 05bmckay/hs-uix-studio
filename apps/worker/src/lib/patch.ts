// Minimal RFC 6902 JSON Patch applier. Supports add / remove / replace — the
// three ops Studio actually needs for targeted spec edits. Move/copy/test
// aren't useful for iterative card revisions, so we skip them.
//
// JSON Pointer segments are decoded per RFC 6901 (~1 → /, ~0 → ~).
// Array appends use "-" as the last segment ("/root/children/-").

export interface PatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

export interface PatchResult {
  ok: boolean;
  value?: unknown;
  // Index of the failing op (0-based); undefined when ok.
  failedIndex?: number;
  error?: string;
}

export function applyPatch(doc: unknown, ops: PatchOp[]): PatchResult {
  let cur = deepClone(doc);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      cur = applyOne(cur, op);
    } catch (err) {
      return {
        ok: false,
        failedIndex: i,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: true, value: cur };
}

function applyOne(doc: unknown, op: PatchOp): unknown {
  if (!op || typeof op !== "object") throw new Error("op must be an object");
  if (typeof op.path !== "string") throw new Error("op.path must be a string");

  const segments = parsePointer(op.path);

  if (op.op === "add" || op.op === "replace") {
    if (!("value" in op)) throw new Error(`${op.op} requires value`);
    return setAtPath(doc, segments, op.value, op.op);
  }
  if (op.op === "remove") {
    return removeAtPath(doc, segments);
  }
  throw new Error(`unsupported op: ${op.op}`);
}

function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`pointer must start with /: ${path}`);
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function setAtPath(
  doc: unknown,
  segments: string[],
  value: unknown,
  mode: "add" | "replace",
): unknown {
  if (segments.length === 0) return value; // Whole-doc replace.
  const [head, ...rest] = segments;
  if (rest.length === 0) return writeLeaf(doc, head, value, mode);
  // Recurse into head; write back onto a shallow copy.
  if (Array.isArray(doc)) {
    const idx = toIndex(head, doc.length, mode, false);
    const copy = doc.slice();
    copy[idx] = setAtPath(doc[idx], rest, value, mode);
    return copy;
  }
  if (doc && typeof doc === "object") {
    const src = doc as Record<string, unknown>;
    if (!(head in src)) {
      throw new Error(`path does not exist: /${segments.join("/")}`);
    }
    return { ...src, [head]: setAtPath(src[head], rest, value, mode) };
  }
  throw new Error(`cannot descend into ${typeof doc} at segment "${head}"`);
}

function writeLeaf(
  doc: unknown,
  key: string,
  value: unknown,
  mode: "add" | "replace",
): unknown {
  if (Array.isArray(doc)) {
    const idx = toIndex(key, doc.length, mode, true);
    const copy = doc.slice();
    if (mode === "add") {
      copy.splice(idx, 0, value);
    } else {
      if (idx >= copy.length) {
        throw new Error(`replace index ${idx} out of bounds`);
      }
      copy[idx] = value;
    }
    return copy;
  }
  if (doc && typeof doc === "object") {
    const src = doc as Record<string, unknown>;
    if (mode === "replace" && !(key in src)) {
      throw new Error(`replace target does not exist: "${key}"`);
    }
    return { ...src, [key]: value };
  }
  throw new Error(`cannot write into ${typeof doc}`);
}

function removeAtPath(doc: unknown, segments: string[]): unknown {
  if (segments.length === 0) {
    throw new Error("cannot remove root");
  }
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    if (Array.isArray(doc)) {
      const idx = toIndex(head, doc.length, "replace", false);
      if (idx >= doc.length) throw new Error(`remove index ${idx} out of bounds`);
      const copy = doc.slice();
      copy.splice(idx, 1);
      return copy;
    }
    if (doc && typeof doc === "object") {
      const src = doc as Record<string, unknown>;
      if (!(head in src)) {
        throw new Error(`remove target does not exist: "${head}"`);
      }
      const copy = { ...src };
      delete copy[head];
      return copy;
    }
    throw new Error(`cannot remove from ${typeof doc}`);
  }
  if (Array.isArray(doc)) {
    const idx = toIndex(head, doc.length, "replace", false);
    const copy = doc.slice();
    copy[idx] = removeAtPath(doc[idx], rest);
    return copy;
  }
  if (doc && typeof doc === "object") {
    const src = doc as Record<string, unknown>;
    if (!(head in src)) {
      throw new Error(`path does not exist: /${segments.join("/")}`);
    }
    return { ...src, [head]: removeAtPath(src[head], rest) };
  }
  throw new Error(`cannot descend into ${typeof doc}`);
}

function toIndex(
  segment: string,
  length: number,
  mode: "add" | "replace",
  allowAppend: boolean,
): number {
  if (segment === "-") {
    if (!allowAppend || mode !== "add") {
      throw new Error(`"-" only valid as the last segment of an add op`);
    }
    return length;
  }
  if (!/^\d+$/.test(segment)) {
    throw new Error(`array segment must be a non-negative integer: "${segment}"`);
  }
  return Number(segment);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
