# Spec schema

`spec.schema.json` is the JSON Schema (draft 2020-12) for the v1 card spec
format — the `{ meta, state, data, root, elements }` adjacency-list shape.

**Generated — do not edit by hand.** The component and action catalog in
`apps/worker/src/catalog.ts` is the source of truth; regenerate with:

```bash
cd apps/worker && npm run schema:build
```

(`predev`/`predeploy` run it automatically, same as `knowledge:build`.)

## Division of labor

- **This schema** — structural shape: top-level keys, node/children forms,
  `$forEach` / `$render` markers, action-descriptor kinds + params, the
  `watch` map, and the closed set of component `type` names.
- **`specs/README.md`** — authoring conventions the schema can't express:
  `$state.*`/`$data.*` references, `{{path}}` templates, expression objects,
  `$bindState`, the derivation policy.
- **`apps/worker/src/tools/validate.ts`** — deep semantic checks: root
  reachability, dangling children IDs, action descriptors nested in event
  props, per-component gotchas (e.g. `Icon.name` required).

## Validating a spec

```bash
npx ajv-cli@5 validate --spec=draft2020 -s schema/spec.schema.json -d path/to/spec.json
```

All specs in `specs/` and `apps/worker/knowledge/examples/` validate.
