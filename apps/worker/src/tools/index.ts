// Tool manifest (OpenAI function-tool shape, sent via the Cloudflare AI Gateway
// unified /compat/chat/completions endpoint) + dispatcher (executes tool calls
// and returns tool result content). Keep handlers pure — they only read from
// the static knowledge base, no DB or network I/O.

import { STANDARDS, BLOCKS, EXAMPLES, STANDARDS_DESCRIPTIONS } from "./knowledge";
import { searchKnowledge } from "./search";
import { lintSpec } from "./lint";

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "Keyword search across all standards docs, prebuilt blocks, and example cards. Returns ranked hits with name, kind, description, and a short snippet. Prefer this over list_knowledge when you know what you're looking for (e.g. 'table filter', 'empty state', 'accordion'). Use list_knowledge only when you want a full inventory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search for" },
          limit: { type: "number", description: "Max hits to return (default 8)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_knowledge",
      description:
        "Return a full index of every standards doc, prebuilt block, and example card available. Use when you need a full inventory; prefer search_knowledge for targeted lookups.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_standards",
      description:
        "Read the full markdown of a standards doc by filename (e.g. 'tables.md', 'states.md', 'RULES.md'). Pull what's relevant to the archetype you're building.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Filename from the standards index (e.g. 'tables.md')" },
        },
        required: ["file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_block",
      description:
        "Read a prebuilt JSON block you can compose into a spec. Returns { description, componentsUsed, dataShape?, node }. Prefer blocks over hand-rolling repeat patterns.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Block name (e.g. 'stats-row', 'view-mode-shell')" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_example",
      description:
        "Read a full sample card spec for reference (e.g. 'construction-delays'). Use to study structure and derivation style, not to copy wholesale.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Example name (no extension)" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lint_spec",
      description:
        "Check a candidate spec for platform-level issues that the HubSpot renderer would toast at the user (invalid Icon names, missing Icon.name, invalid EmptyState imageName, wrong StatisticsTrend direction, non-Icon children inside Button/Link, Icon nested in Text, etc.). Use before patch_spec when you're not sure about an enum value or a component's child contract. Returns { issues: [{ path, rule, severity, message }] }. Empty array means the spec passes every known rule. This is a pure check — it does not mutate or commit anything.",
      parameters: {
        type: "object",
        properties: {
          spec: { type: "object", description: "The full spec JSON to lint" },
        },
        required: ["spec"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_questions",
      description:
        "Ask the user clarifying questions before building a spec. Use on the first turn of a new card when the brief is ambiguous — confirm what the card should drive, surface, object, primary user, data realism, variation appetite. Skip for small tweaks, follow-ups, or when the user already gave you enough. Every single-select and multi-select MUST include escape hatches — a 'Let you decide' option and an 'Other' option — and open-ended dimensions (what the card drives, which fields matter, what a term means for this team) should be long-text, not selects. Calling this ends the turn: do NOT also build a spec in the same turn; wait for the user's answers to arrive as a follow-up message.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description:
              "Ordered list of questions. 5–8 for a normal new card, up to ~10 for truly vague briefs, down to 2–3 if most context is already given. Put the most load-bearing question first (usually what the card should drive, not what object it lives on). Prefer long-text for open-ended dimensions; every select must include 'Let you decide' and 'Other' options.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable snake-case key for this question (e.g. 'surface', 'primary_user'). Used to correlate answers.",
                },
                type: {
                  type: "string",
                  enum: ["short-text", "long-text", "single-select", "multi-select"],
                  description:
                    "short-text = one-line Input. long-text = multi-line TextArea. single-select = dropdown; requires options[]. multi-select = checkbox list; requires options[]; PREFER this over single-select whenever picking more than one value is plausible.",
                },
                prompt: {
                  type: "string",
                  description: "The question shown to the user. Sentence case, no trailing period needed.",
                },
                placeholder: {
                  type: "string",
                  description: "Optional hint text for short-text / long-text inputs.",
                },
                required: {
                  type: "boolean",
                  description: "If true, Submit is disabled until the user answers.",
                },
                options: {
                  type: "array",
                  description: "Required for single-select and multi-select. Array of { label, value } pairs.",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      value: { type: "string" },
                    },
                    required: ["label", "value"],
                  },
                },
              },
              required: ["id", "type", "prompt"],
            },
          },
        },
        required: ["questions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_spec",
      description:
        "PRIMARY build/edit tool for all spec creation and edits. Apply RFC 6902 JSON Patch ops to the project spec; if no spec exists yet, patch_spec starts from an empty v1 adjacency-list shell, so a new card can be created by replacing /meta, /state, /data, /root, and /elements in one atomic patch. Supported ops: 'add', 'remove', 'replace'. The result is validated and persisted. Use small section-level patches for progressive builds after the initial shell/full rewrite. Example: to append a child, 'add' at path '/elements/card-root/children/-'. Returns { ok, spec?, errors?, failedIndex? }.",
      parameters: {
        type: "object",
        properties: {
          ops: {
            type: "array",
            description:
              "Array of { op, path, value? } operations. Paths use JSON Pointer syntax (e.g. '/elements/deal-header/children' or '/elements/status-tag/variant'). Use '-' as the last segment of an 'add' path to append to an array.",
            items: {
              type: "object",
              properties: {
                op: {
                  type: "string",
                  enum: ["add", "remove", "replace"],
                },
                path: { type: "string" },
                value: {},
              },
              required: ["op", "path"],
            },
          },
          note: {
            type: "string",
            description:
              "Optional one-line summary of what changed — shown alongside the preview.",
          },
        },
        required: ["ops"],
      },
    },
  },
] as const;

export interface ToolResult {
  ok: boolean;
  value: unknown;
}

export function dispatchTool(
  name: string,
  input: Record<string, unknown>,
): ToolResult {
  try {
    switch (name) {
      case "search_knowledge": {
        const query = String(input.query ?? "");
        const limit =
          typeof input.limit === "number" && input.limit > 0 ? input.limit : undefined;
        return { ok: true, value: { hits: searchKnowledge(query, limit) } };
      }
      case "list_knowledge":
        return { ok: true, value: listKnowledge() };
      case "read_standards":
        return readStandards(String(input.file ?? ""));
      case "read_block":
        return readBlock(String(input.name ?? ""));
      case "read_example":
        return readExample(String(input.name ?? ""));
      case "lint_spec":
        return { ok: true, value: { issues: lintSpec(input.spec) } };
      default:
        return { ok: false, value: { error: `unknown tool: ${name}` } };
    }
  } catch (err) {
    return {
      ok: false,
      value: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

function listKnowledge(): unknown {
  return {
    standards: Object.entries(STANDARDS_DESCRIPTIONS).map(([file, description]) => ({
      file,
      description,
    })),
    blocks: Object.entries(BLOCKS).map(([name, block]) => ({
      name,
      description: block.description,
      componentsUsed: block.componentsUsed,
    })),
    examples: Object.keys(EXAMPLES).map((name) => ({
      name,
      description: describeExample(EXAMPLES[name]),
    })),
  };
}

function readStandards(file: string): ToolResult {
  const doc = STANDARDS[file];
  if (!doc) {
    return {
      ok: false,
      value: {
        error: `unknown standards file: ${file}`,
        available: Object.keys(STANDARDS),
      },
    };
  }
  return { ok: true, value: { file, contents: doc } };
}

function readBlock(name: string): ToolResult {
  const block = BLOCKS[name];
  if (!block) {
    return {
      ok: false,
      value: { error: `unknown block: ${name}`, available: Object.keys(BLOCKS) },
    };
  }
  return { ok: true, value: block };
}

function readExample(name: string): ToolResult {
  const example = EXAMPLES[name];
  if (!example) {
    return {
      ok: false,
      value: { error: `unknown example: ${name}`, available: Object.keys(EXAMPLES) },
    };
  }
  return { ok: true, value: example };
}

function describeExample(ex: unknown): string {
  if (
    ex &&
    typeof ex === "object" &&
    "meta" in ex &&
    ex.meta &&
    typeof ex.meta === "object" &&
    "description" in ex.meta &&
    typeof (ex.meta as { description: unknown }).description === "string"
  ) {
    return (ex.meta as { description: string }).description;
  }
  return "(no description)";
}
