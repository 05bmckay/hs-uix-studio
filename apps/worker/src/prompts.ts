// Inlines the system prompt at build time via ?raw. Keep the prompt as a
// standalone markdown file so non-engineers can review/edit it without
// wading through TypeScript.

import { toPromptSection } from "./catalog.js";
import {
  STANDARDS,
  STANDARDS_DESCRIPTIONS,
  BLOCKS,
  EXAMPLES_DESCRIPTIONS,
} from "./tools/knowledge.js";

// @ts-expect-error — wrangler [[rules]] Text loader inlines .md as string.
import studioSystem from "../prompts/studio_system.md";
// @ts-expect-error — wrangler [[rules]] Text loader inlines .md as string.
import designDoc from "../prompts/design_doc.md";

const catalogSection = toPromptSection();

// Compact inventory of every standards file, block, and example. Inlined in
// the system prompt so the model always sees what's available instead of
// having to call list_knowledge to discover it.
function buildKnowledgeIndex(): string {
  const lines: string[] = ["## Knowledge index", ""];

  lines.push("### Standards (read with `read_standards`)");
  const standardsOrder = [
    "RULES.md",
    "INDEX.md",
    "COMPONENTS.md",
    "card-building-process.md",
    "layout.md",
    "typography.md",
    "buttons-and-actions.md",
    "forms.md",
    "tables.md",
    "data-display.md",
    "data-and-state.md",
    "navigation.md",
    "overlays.md",
    "states.md",
    "status-and-tags.md",
    "media.md",
    "crm-components.md",
    "kanban.md",
    "gotchas.md",
    "utils.md",
  ];
  const seen = new Set<string>();
  for (const key of standardsOrder) {
    const desc = STANDARDS_DESCRIPTIONS[key];
    if (!desc) continue;
    lines.push(`- **${key}** — ${desc}`);
    seen.add(key);
  }
  for (const [key, desc] of Object.entries(STANDARDS_DESCRIPTIONS)) {
    if (seen.has(key)) continue;
    lines.push(`- **${key}** — ${desc}`);
  }
  lines.push("");

  lines.push("### Blocks (read with `read_block` — prefer over hand-rolling)");
  for (const [name, block] of Object.entries(BLOCKS)) {
    const desc = block.description || "";
    // First sentence, capped at ~140 chars.
    const firstSentence = desc.split(/(?<=[.!?])\s/)[0] ?? "";
    const trimmed =
      firstSentence.length > 140
        ? firstSentence.slice(0, 137) + "..."
        : firstSentence;
    lines.push(`- **${name}** — ${trimmed}`);
  }
  lines.push("");

  lines.push("### Examples (read with `read_example`)");
  for (const [name, desc] of Object.entries(EXAMPLES_DESCRIPTIONS)) {
    lines.push(`- **${name}** — ${desc}`);
  }
  lines.push("");

  lines.push(
    "This is the full inventory. Before building, scan this list and plan which blocks and standards you'll pull — don't start a card without checking whether there's already a block for a section you need.",
  );
  return lines.join("\n");
}

const knowledgeIndexSection = buildKnowledgeIndex();

// Inline RULES.md verbatim. It's the hard-rules checklist every spec is
// validated against — keeping it always-visible beats hoping the model calls
// read_standards("RULES.md") on each turn.
const rulesSection = STANDARDS["RULES.md"] ?? "";

export const STUDIO_SYSTEM_PROMPT: string = (studioSystem as string)
  .replace(/\{\{CATALOG\}\}/g, catalogSection)
  .replace(/\{\{KNOWLEDGE_INDEX\}\}/g, knowledgeIndexSection)
  .replace(/\{\{RULES\}\}/g, rulesSection);
export const DESIGN_DOC_PROMPT: string = designDoc;
