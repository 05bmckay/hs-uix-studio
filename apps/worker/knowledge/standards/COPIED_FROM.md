# Provenance

These standards were forked from the upstream `UI-EXTENSIONS-STANDARDS/standards` repo and then **diverged** to fit Studio's narrower scope. Do not re-sync blindly from upstream — we actively edit these files to remove rules that don't apply (e.g. CRM property hooks, record-context data fetching) and add rules specific to Studio's JSON-spec output.

When upstream changes land that we want to pick up, do a manual diff and copy over the relevant portions.

## What Studio drops from upstream

- Anything tied to `useCrmProperties`, `fetchCrmObjectProperties`, record-page data hooks — Studio renders specs, it doesn't fetch live CRM data.
- `copyTextToClipboard` guidance — no clipboard surface in Studio previews.
- Any rule that references running inside a real CRM record context.

## What Studio adds on top (Studio-specific)

- JSON spec format rules (expression language, `$forEach`, `visible`, template strings).
- Derivation policy: pre-compute into `data`, don't express transformations in the spec.
- Name-field convention on structural containers (`Flex`, `Box`, `AutoGrid`) for comment-mode labels.
- Block composition: prefer `knowledge/blocks/*.json` over hand-rolling repeat patterns.
