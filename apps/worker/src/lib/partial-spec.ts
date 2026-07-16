// Partial-spec streaming parser.
//
// Tool-call arguments arrive as a stream of text deltas over 10-30 seconds —
// this module consumes those deltas and emits events as meaningful pieces of
// the spec become extractable. The goal is not to be a full JSON parser; it's
// scoped to the two known tool-argument shapes:
//
//   emit_spec / emit_skeleton:  { "spec": { ..., "elements": { id: {...}, ... } }, "note"?: string }
//   patch_spec:                  { "ops": [ {op,path,value}, ... ], "note"?: string }
//
// Events:
//   "element"   — a new spec.elements[id] entry has fully streamed; we have
//                 { id, node } to write as an `add` patch.
//   "meta"      — top-level shell of the spec (root, state, data, meta) became
//                 parseable (before `elements` started receiving entries).
//   "op"        — a single RFC-6902 op from patch_spec ops[] completed.
//
// The parser is a small brace-tracking state machine. It does NOT attempt to
// be robust against every malformed Anthropic output; it assumes the model
// emits structurally valid JSON and focuses on cleanly detecting "a top-level
// value just closed at depth N." That's enough for our shape.

export type ParserEvent =
  | { type: "element"; id: string; node: unknown }
  | { type: "meta"; shell: Record<string, unknown> }  // spec without elements
  | { type: "op"; index: number; op: unknown };

export interface PartialSpecParser {
  /**
   * Feed a chunk of tool-call-argument text. Returns any events that became
   * extractable from the combined buffer so far.
   */
  push(chunk: string): ParserEvent[];
  /**
   * Mark the input complete. Any trailing values that hadn't closed get one
   * final JSON.parse attempt. Returns late events (typically none — the final
   * JSON.parse of the full buffer is a separate, authoritative path).
   */
  end(): ParserEvent[];
  /** The raw buffer so far — useful for the authoritative final parse. */
  buffer(): string;
}

// ---------------------------------------------------------------------------
// emit_spec / emit_skeleton shape parser.
// ---------------------------------------------------------------------------

// Strategy:
//   - Scan forward, tracking brace/bracket depth, string state, escape state.
//   - Mark offsets of: `"elements"` key, its `:`, the `{` that opens it.
//   - Inside elements{}, entries look like  "id": { ... }  separated by commas.
//   - Track depth RELATIVE to the elements `{`. When we return to depth 0 inside
//     elements AFTER consuming a value, we have a complete entry from the last
//     comma/opening-brace to the most recent `}`.
//   - Parse that entry and emit an "element" event.
//
// Keys before `"elements"` (meta/state/data/root) are not extracted individually —
// we emit a single "meta" event when we see `"elements":{` open, containing
// everything that preceded it as a partial JSON shell.

interface SpecParserState {
  buf: string;
  pos: number;            // next char to scan
  inString: boolean;
  escaped: boolean;
  depth: number;          // overall brace/bracket depth
  // Forward-tracked string opener — captured when we enter a string, consumed
  // when we leave. Avoids an O(n) backward scan per string close, which is
  // the difference between O(n) and O(n²) for large tool-arg buffers.
  stringOpenPos: number;
  // `elements` tracking:
  elementsOpenPos: number;  // index of `{` that opens the elements object; -1 before found
  elementsDepth: number;    // depth at the moment elements `{` was consumed (so relative=0 means inside elements)
  entryKey: string | null;  // the current element id being read
  entryValueStart: number;  // buffer index where the current entry's value starts (`{` position), -1 if between entries
  metaEmitted: boolean;     // whether we've fired the "meta" event for the shell
  // Pending-key detection — we track the most recent quoted key before a `:`.
  pendingKey: string | null;
  pendingKeyEnd: number;    // index just after the closing `"` of pendingKey
}

function createSpecParser(): PartialSpecParser {
  const state: SpecParserState = {
    buf: "",
    pos: 0,
    inString: false,
    escaped: false,
    depth: 0,
    stringOpenPos: -1,
    elementsOpenPos: -1,
    elementsDepth: -1,
    entryKey: null,
    entryValueStart: -1,
    metaEmitted: false,
    pendingKey: null,
    pendingKeyEnd: -1,
  };

  function advance(events: ParserEvent[]): void {
    for (; state.pos < state.buf.length; state.pos++) {
      const ch = state.buf[state.pos];

      if (state.inString) {
        if (state.escaped) { state.escaped = false; continue; }
        if (ch === "\\") { state.escaped = true; continue; }
        if (ch === '"') {
          state.inString = false;
          // Use the forward-captured opener instead of back-scanning.
          const startIdx = state.stringOpenPos;
          if (startIdx >= 0 && isKeyContext(state.buf, startIdx)) {
            state.pendingKey = state.buf.slice(startIdx + 1, state.pos);
            state.pendingKeyEnd = state.pos + 1;
          }
          state.stringOpenPos = -1;
        }
        continue;
      }

      if (ch === '"') {
        state.inString = true;
        state.stringOpenPos = state.pos;
        continue;
      }

      if (ch === "{" || ch === "[") {
        // If we were waiting for a value after a pendingKey, this brace opens
        // that value.
        const prevDepth = state.depth;
        state.depth++;

        // First brace / bracket sets elements-tracking if applicable.
        if (
          state.elementsOpenPos < 0 &&
          state.pendingKey === "elements" &&
          ch === "{"
        ) {
          // We've just opened the elements{} map.
          state.elementsOpenPos = state.pos;
          state.elementsDepth = prevDepth; // parent depth
          state.pendingKey = null;

          // Emit a "meta" event: try to parse everything before elements as a
          // partial shell (plus `}` to close the outer spec).
          if (!state.metaEmitted) {
            const shell = tryParseShell(state.buf, state.pos);
            if (shell) {
              events.push({ type: "meta", shell });
              state.metaEmitted = true;
            }
          }
          continue;
        }

        // Inside elements: if we're exactly one level in and opened a value brace,
        // remember the start and key.
        if (
          state.elementsOpenPos >= 0 &&
          state.depth - state.elementsDepth === 2 &&
          state.entryValueStart < 0 &&
          state.pendingKey !== null &&
          state.pendingKey !== "elements"
        ) {
          state.entryKey = state.pendingKey;
          state.entryValueStart = state.pos;
          state.pendingKey = null;
        }
        continue;
      }

      if (ch === "}" || ch === "]") {
        state.depth--;
        // Are we closing an element entry? Entry closes when depth goes from
        // elementsDepth+2 to elementsDepth+1 via a `}`.
        if (
          state.elementsOpenPos >= 0 &&
          ch === "}" &&
          state.depth === state.elementsDepth + 1 &&
          state.entryValueStart >= 0 &&
          state.entryKey !== null
        ) {
          const slice = state.buf.slice(state.entryValueStart, state.pos + 1);
          try {
            const node = JSON.parse(slice);
            events.push({ type: "element", id: state.entryKey, node });
          } catch {
            // Malformed; skip — the final authoritative parse will error if
            // needed.
          }
          state.entryKey = null;
          state.entryValueStart = -1;
        }
        continue;
      }

      // Any other char — nothing to do.
    }
  }

  return {
    push(chunk: string): ParserEvent[] {
      state.buf += chunk;
      const events: ParserEvent[] = [];
      advance(events);
      return events;
    },
    end(): ParserEvent[] {
      const events: ParserEvent[] = [];
      advance(events);
      return events;
    },
    buffer(): string {
      return state.buf;
    },
  };
}

// ---------------------------------------------------------------------------
// patch_spec ops[] parser.
// ---------------------------------------------------------------------------

// Input shape: { "ops": [ {...}, {...}, ... ], "note"?: "..." }
// Emit "op" events as each element of the ops array completes.
//
// Big-op decomposition: the creation / full-rewrite pattern puts EVERY
// element into a single `{ "op": "add", "path": "/elements", "value": {...} }`
// op, which under plain op-granularity streaming means zero preview until the
// whole spec has streamed (10-30s). When we see an op whose `path` is
// "/elements" open an object-valued `value`, we switch to per-entry tracking
// (same approach as the emit_spec parser's elements handling): emit a
// synthetic `add /elements {}` op to reset the map with the original op's
// semantics, then one "element" event per completed entry. The final
// completed big op is then suppressed — its content already streamed out —
// unless any entry failed to parse, in which case the full op is emitted as
// the correctness fallback (duplicate-but-idempotent for the client mirror).

interface PatchOpsState {
  buf: string;
  pos: number;
  inString: boolean;
  escaped: boolean;
  depth: number;
  stringOpenPos: number;
  opsOpenPos: number;       // index of `[` for ops; -1 before found
  opsDepth: number;         // depth at the moment `[` was consumed
  itemValueStart: number;   // start of current ops[] item value
  pendingKey: string | null;
  pendingKeyEnd: number;
  opIndex: number;
  // Big-op decomposition state:
  itemPath: string | null;   // the current op's `path` value, once its string closes
  inElementsValue: boolean;  // inside the object value of an /elements op
  entryKey: string | null;   // current element id being read inside that value
  entryValueStart: number;   // buffer index of the entry's opening `{`
  opDecomposed: boolean;     // this op streamed out as element events
  decomposeFailed: boolean;  // an entry failed to parse — emit the full op after all
}

function createPatchOpsParser(): PartialSpecParser {
  const state: PatchOpsState = {
    buf: "",
    pos: 0,
    inString: false,
    escaped: false,
    depth: 0,
    stringOpenPos: -1,
    opsOpenPos: -1,
    opsDepth: -1,
    itemValueStart: -1,
    pendingKey: null,
    pendingKeyEnd: -1,
    opIndex: 0,
    itemPath: null,
    inElementsValue: false,
    entryKey: null,
    entryValueStart: -1,
    opDecomposed: false,
    decomposeFailed: false,
  };

  function advance(events: ParserEvent[]): void {
    for (; state.pos < state.buf.length; state.pos++) {
      const ch = state.buf[state.pos];

      if (state.inString) {
        if (state.escaped) { state.escaped = false; continue; }
        if (ch === "\\") { state.escaped = true; continue; }
        if (ch === '"') {
          state.inString = false;
          const startIdx = state.stringOpenPos;
          if (startIdx >= 0 && isKeyContext(state.buf, startIdx)) {
            state.pendingKey = state.buf.slice(startIdx + 1, state.pos);
            state.pendingKeyEnd = state.pos + 1;
          } else if (
            state.pendingKey === "path" &&
            state.itemValueStart >= 0 &&
            state.depth === state.opsDepth + 2
          ) {
            // The current op's `path` value just closed (depth check keeps
            // this from matching "path" keys nested inside `value`).
            state.itemPath = state.buf.slice(startIdx + 1, state.pos);
            state.pendingKey = null;
          }
          state.stringOpenPos = -1;
        }
        continue;
      }

      if (ch === '"') {
        state.inString = true;
        state.stringOpenPos = state.pos;
        continue;
      }

      if (ch === "[" || ch === "{") {
        const prev = state.depth;
        state.depth++;

        // ops: [ ... ] — detect opening of the ops array.
        if (
          state.opsOpenPos < 0 &&
          ch === "[" &&
          state.pendingKey === "ops"
        ) {
          state.opsOpenPos = state.pos;
          state.opsDepth = prev;
          state.pendingKey = null;
          continue;
        }

        // Inside ops[], if we open `{` at depth opsDepth+2, it's a new op item.
        if (
          state.opsOpenPos >= 0 &&
          ch === "{" &&
          state.depth - state.opsDepth === 2 &&
          state.itemValueStart < 0
        ) {
          state.itemValueStart = state.pos;
          state.itemPath = null;
          state.opDecomposed = false;
          state.decomposeFailed = false;
          continue;
        }

        // An /elements op's object value just opened — switch to per-entry
        // decomposition. The synthetic reset op carries the original op's
        // replace-the-whole-map semantics before individual adds stream in.
        if (
          state.opsOpenPos >= 0 &&
          ch === "{" &&
          !state.inElementsValue &&
          state.pendingKey === "value" &&
          state.itemPath === "/elements" &&
          state.itemValueStart >= 0 &&
          state.depth === state.opsDepth + 3
        ) {
          state.inElementsValue = true;
          state.pendingKey = null;
          events.push({
            type: "op",
            index: state.opIndex++,
            op: { op: "add", path: "/elements", value: {} },
          });
          continue;
        }

        // Element entry inside the /elements value: `"id": {` one level in.
        if (
          state.inElementsValue &&
          ch === "{" &&
          state.depth === state.opsDepth + 4 &&
          state.entryValueStart < 0 &&
          state.pendingKey !== null
        ) {
          state.entryKey = state.pendingKey;
          state.entryValueStart = state.pos;
          state.pendingKey = null;
        }
        continue;
      }

      if (ch === "]" || ch === "}") {
        state.depth--;

        // A complete element entry closed inside the /elements value.
        if (
          state.inElementsValue &&
          ch === "}" &&
          state.depth === state.opsDepth + 3 &&
          state.entryValueStart >= 0 &&
          state.entryKey !== null
        ) {
          const slice = state.buf.slice(state.entryValueStart, state.pos + 1);
          try {
            const node = JSON.parse(slice);
            events.push({ type: "element", id: state.entryKey, node });
          } catch {
            state.decomposeFailed = true;
          }
          state.entryKey = null;
          state.entryValueStart = -1;
          continue;
        }

        // The /elements value object itself closed.
        if (
          state.inElementsValue &&
          ch === "}" &&
          state.depth === state.opsDepth + 2
        ) {
          state.inElementsValue = false;
          state.opDecomposed = true;
          continue;
        }

        if (
          state.opsOpenPos >= 0 &&
          ch === "}" &&
          state.depth === state.opsDepth + 1 &&
          state.itemValueStart >= 0
        ) {
          // Decomposed ops already streamed out as element events — emitting
          // the completed big op too would just resend every element in bulk.
          // Emit it only as the fallback when an entry failed to parse.
          if (!state.opDecomposed || state.decomposeFailed) {
            const slice = state.buf.slice(state.itemValueStart, state.pos + 1);
            try {
              const op = JSON.parse(slice);
              events.push({ type: "op", index: state.opIndex++, op });
            } catch {
              // skip
            }
          }
          state.itemValueStart = -1;
          state.itemPath = null;
          state.opDecomposed = false;
          state.decomposeFailed = false;
        }
        continue;
      }
    }
  }

  return {
    push(chunk: string): ParserEvent[] {
      state.buf += chunk;
      const events: ParserEvent[] = [];
      advance(events);
      return events;
    },
    end(): ParserEvent[] {
      const events: ParserEvent[] = [];
      advance(events);
      return events;
    },
    buffer(): string {
      return state.buf;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A string is in "key context" if the last non-whitespace char before the
// opening `"` is `{` or `,`.
function isKeyContext(buf: string, openIdx: number): boolean {
  for (let i = openIdx - 1; i >= 0; i--) {
    const c = buf[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") continue;
    return c === "{" || c === ",";
  }
  return false;
}

// Try to parse the prefix-up-to-elements as a partial spec shell. Strategy:
// take buf[0..elementsOpenPos) plus `}` to close the outer spec. That gives us
// `{"meta":{...},"state":{...},"data":{...},"root":"...","elements":` then we
// rewrite the trailing `"elements":` with `}` to make it valid JSON.
function tryParseShell(buf: string, elementsOpenPos: number): Record<string, unknown> | null {
  // Walk backwards from elementsOpenPos to find the `,"elements":{` run and
  // strip it entirely.
  let i = elementsOpenPos - 1;
  while (i >= 0 && (buf[i] === " " || buf[i] === ":" || buf[i] === "\t" || buf[i] === "\n" || buf[i] === "\r")) i--;
  // i should now point at the closing `"` of `"elements"`.
  if (i < 0 || buf[i] !== '"') return null;
  i--;
  while (i >= 0 && buf[i] !== '"') i--;
  if (i < 0) return null;
  i--;
  while (i >= 0 && (buf[i] === " " || buf[i] === "\t" || buf[i] === "\n" || buf[i] === "\r")) i--;
  if (i < 0) return null;
  // i points at the separator before the key: `{` or `,`.
  const prefix = buf.slice(0, i + 1);
  const candidate = buf[i] === "," ? prefix.slice(0, -1) + "}" : prefix + "}";
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createParser(kind: "emit_spec" | "patch_spec"): PartialSpecParser {
  return kind === "patch_spec" ? createPatchOpsParser() : createSpecParser();
}
