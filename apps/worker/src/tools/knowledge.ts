// Thin re-export of the auto-generated knowledge manifest. The generated
// file is produced by scripts/build-knowledge.mjs, which scans
// apps/worker/knowledge/ at build time. Adding a new standards file, block,
// or example is "drop it in the directory" — the next dev/deploy run will
// regenerate this manifest and pick it up.
//
// Do not add manual entries here. Edit the source files or the build script.

export {
  STANDARDS,
  STANDARDS_DESCRIPTIONS,
  BLOCKS,
  EXAMPLES,
  EXAMPLES_DESCRIPTIONS,
} from "./knowledge.generated";
