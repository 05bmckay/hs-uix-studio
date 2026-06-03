# Specs

JSON specs for sample cards. Hand-authored in v0 to discover the format.

## Current conventions (v0 — will change)

### Top-level shape

```json
{
  "meta": { "name": "...", "description": "...", "surface": "...", "object": "..." },
  "state": { "... mutable state, readable as $state.key": true },
  "data": { "... mock/static data, readable as $data.key": true },
  "root": "card-root",
  "elements": {
    "card-root": { "type": "Flex", "children": ["hero", "stats"] },
    "hero": { "type": "SectionHeader", "title": "..." },
    "stats": { "type": "Statistics", "children": ["stat-1"] },
    "stat-1": { "type": "StatisticsItem", "label": "...", "number": "..." }
  }
}
```

`root` is a string ID that must exist as a key in `elements`. Every node in the card lives in the adjacency-list map keyed by a unique ID.

### Nodes

```json
{
  "type": "Flex",
  "name": "card-root",
  "direction": "column",
  "gap": "sm",
  "children": ["hero", "details"],
  "visible": true
}
```

Props are **hoisted** to the node's top level — there is no `props` object. Reserved structural keys (`type`, `children`, `visible`, `name`) are the only top-level keys the renderer consumes directly; every other key is a component prop.

### Children

`children` is an array of entries. Each entry is:

- **An element ID string** (e.g. `"hero"`) — resolved via `elements[id]`.
- **A text/template/reference string** (e.g. `"Hello {{data.name}}"`, `"$data.label"`, `"Log delay"`) — rendered as the component's text content.
- **An inline object** — only used for iteration templates (`$forEach`) and lazy render markers (`$render`), which are per-instance and not ID-addressable.

The renderer disambiguates string entries by lookup: if the string matches an `elements` key, it's an ID; otherwise it's text.

For leaf components that take a single text child, `children` may still be a bare string: `{"type": "Text", "children": "Hello"}`.

### IDs

- Use **kebab-case** (`stats-row`, `primary-cta`, `delay-causes-header`). Must be unique within a spec.
- When a structural container has a `name` field, the ID usually matches it — the migration script prefers `name` as the ID source.
- Leaf components get short mechanical IDs (`text-1`, `statusitem-2`) unless they earn a semantic one.

### Node-valued props stay inline

Some props (`overlay` on Button/Link, `renderCell.node` inside DataTable columns, Modal/Panel bodies) contain nested nodes. These are **not** flattened into `elements` — they stay inline. Only the top-level element tree (reachable through `children`) uses the ID/elements map.

### `visible`

Optional; when present and falsy, the node is skipped.

### Naming structural containers

Structural containers (`Flex`, `Box`, `AutoGrid`) accept an optional `name` field. It's not rendered — it's used by Studio's comment-mode structural outline to give each group a human-readable label (e.g. `"delay-causes-section"` instead of `"Flex · column · xs"`). Use kebab-case. Only add `name` where it helps the outline; leaf nodes and repeated `$forEach` render templates don't need it.

### References

Strings that look like `$identifier.path` are path references.

- `$state.viewMode` — mutable state
- `$data.totalDelayDays` — static data
- `$item.cause` — the current iteration variable (see `$forEach`)
- `$mode.value` — any named iteration variable

The segment after `$` must start with a letter or underscore, so display strings such as `"$1,240,000"` or `"$99/mo"` remain literal strings.

### Template strings

Inside string literals, `{{path}}` interpolates. Only produces strings.

```json
"children": "Day {{item.rank}}: {{item.cause}}"
```

### Expression objects

Any object with a `$`-prefixed key at its top level is an expression. Otherwise, objects are literal data passed through to props.

Comparison and logic:

- `{ "$eq": [a, b] }`, `{ "$neq": [a, b] }`
- `{ "$gt": [a, b] }`, `{ "$lt": [a, b] }`, `{ "$gte": [a, b] }`, `{ "$lte": [a, b] }`
- `{ "$and": [...] }`, `{ "$or": [...] }`, `{ "$not": x }`
- `{ "$if": condition, "$then": valueIfTrue, "$else": valueIfFalse }`

Arithmetic (args coerced via `Number()`):

- `{ "$add": [a, b, ...] }`, `{ "$sub": [a, b, ...] }` (left-fold), `{ "$mul": [...] }`, `{ "$div": [a, b, ...] }`, `{ "$mod": [a, b] }`
- `{ "$min": [...] }`, `{ "$max": [...] }`

Collection / string:

- `{ "$length": x }` — works on arrays and strings; `null`/`undefined` → `0`.
- `{ "$slice": [source, start] }` or `{ "$slice": [source, start, end] }` — array or string, mirrors JS `.slice()`.
- `{ "$concat": [a, b, ...] }` — if first arg is an array, returns concatenated array (nulls treated as `[]`); otherwise joins as strings.
- `{ "$includes": [source, item] }` — array or string membership.
- `{ "$coalesce": [a, b, ...] }` — first non-null/undefined arg.

Expressions resolve in **value positions** (any prop value, any non-string child entry). They do **not** resolve inside the string-children slot of leaf text components — `{"type":"Text","children": {"$if": ...}}` won't render a branch as the visible string. Branching display strings should be precomputed into `data` (or driven by a `watch` watcher into `state`) and referenced as a path. This matches the derivation policy below.

**When to use runtime operators vs. precompute into `data`:** display formatting (currency strings, status labels, `"--"` fallbacks, variant selection) still belongs in `data` — those are static for a given dataset and the derivation policy applies. Use the new arithmetic / slice / length operators for **state-dependent** computation that can't be precomputed: pagination (`$slice` against `$state.pageIndex`), counts in headers (`$length` of a filtered list), "show first N" patterns. If the value doesn't depend on `$state`, prefer `data`.

### Static-only props

Some component props are validated against a closed set of literal values at render time and **won't resolve `$item.*`, `$state.*`, or `$data.*` references**. Examples: `Icon.name`, the `variant` prop on Button/Select/Tag, the icon-name prop on `StatusTag`. If you write `{ "type": "Icon", "name": "$item.icon" }` inside a `$forEach`, every iteration silently falls back (or renders nothing).

Workaround: split the iteration into N type-filtered `$forEach` blocks, each with the literal value hardcoded. Filter by `$state` or by a per-item discriminator. The `examples/deal-intelligence-flex.json` activity feed shows the pattern (one `$forEach` per activity type, hardcoded `Icon.name`).

### Iteration

Inside a `children` array, an iteration marker renders its template once per item.

```json
{
  "$forEach": "$data.viewModes",
  "as": "mode",
  "render": { "type": "Button", "variant": "secondary", "children": "$mode.label" }
}
```

### Actions

Event handler props (`onClick`, `onChange`, etc.) accept action descriptors.

```json
{ "$action": "setState", "key": "viewMode", "value": "loading" }
```

Action fields evaluate references normally — `value` can be `"$mode.value"` to close over iteration state.

### Watchers

Declarative reactions to state changes. `spec.watch` is a top-level map from state-key → action (or array of actions). When the watched key's value changes (reference inequality), each action fires once.

```json
{
  "state": { "country": "US", "city": null, "zip": null },
  "watch": {
    "country": [
      { "$action": "setState", "key": "city", "value": null },
      { "$action": "setState", "key": "zip", "value": null }
    ]
  },
  ...
}
```

Canonical use: cascading forms — clearing dependent fields when an upstream value changes. Also useful for firing a `$action: "addAlert"` when a critical state flips.

Rules:
- Fires on value change only, not on initial render.
- Top-level state keys only (same limitation as `$bindState`).
- A watcher that writes the same key it watches loops forever. Author's responsibility to avoid.
- Watchers run in order of declaration for a given key.
- Watchers can only write to `state` (via `setState`), never `data`. If a node needs to read a watcher-derived value, the read path must be `$state.*`. A common bug: watcher writes `$state.fooLabel` but a Text node reads `$data.fooLabel` and never updates.

### Two-way input binding

For controlled form inputs (`Input`, `Select`, `TextArea`, `NumberInput`, `Checkbox`, etc.), use `$bindState` on the value prop instead of wiring `value` + `onChange` by hand:

```json
{ "type": "Input", "label": "Email", "value": { "$bindState": "email" } }
```

Resolves to `value = state.email` AND attaches an `onChange: (v) => setState("email", v)` handler. One of the state keys in `spec.state` must exist for the bind path.

Limitation: top-level state keys only in v1. Nested paths like `form.email` aren't supported — flatten your state (`formEmail`) or compose multiple binds.

Components with non-standard value prop names (`Checkbox` uses `checked`, `Toggle` uses `checked`) — `$bindState` still works; put the marker on whichever prop is the value:

```json
{ "type": "Checkbox", "checked": { "$bindState": "notifyByEmail" } }
```

If the spec sets an explicit `onChange`, that wins — bindState only auto-fills when no handler is present. Use the explicit form when you need side effects beyond state update.

## Derivation policy

Derived values — formatting, variant selection, computed booleans — are **pre-computed into `data`**, not expressed in the spec. In real cards a serverless function will do this before the spec ships. In hand-authored specs, write the resolved values directly. This keeps the spec format narrow.

Example: the React source uses `getTrackingStatus(delayDays)` returning `{ label, variant }`. In the spec, `data` contains `trackingStatusLabel: "Behind schedule"` and `trackingStatusVariant: "error"` directly.

## Known simplifications in v0 drafts

- Chart data arrays are abbreviated where the source has dense data (e.g., 10 points instead of 60). The spec format doesn't care about array length; authoring clarity matters more.
