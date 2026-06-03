// Keyword search across the knowledge base (standards / blocks / examples).
// No tokenization library, no TF-IDF — a simple substring-match scorer is
// plenty when the corpus is ~20 docs and the model is rarely searching for
// anything exotic.
//
// Scoring: name/description hits weigh higher than body hits. Returns the top
// N results with short snippets so the model can decide which doc to fully
// read via read_standards/read_block/read_example.

import { STANDARDS, STANDARDS_DESCRIPTIONS, BLOCKS, EXAMPLES } from "./knowledge";

export interface SearchHit {
  kind: "standards" | "block" | "example";
  name: string;
  description: string;
  score: number;
  snippet?: string;
}

export function searchKnowledge(query: string, limit = 8): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];

  // Standards files — search filename, description, and body.
  for (const [file, body] of Object.entries(STANDARDS)) {
    const description = STANDARDS_DESCRIPTIONS[file] ?? "";
    const score = scoreDoc(terms, file, description, body);
    if (score > 0) {
      hits.push({
        kind: "standards",
        name: file,
        description,
        score,
        snippet: firstMatchSnippet(body, terms),
      });
    }
  }

  // Blocks — name + description (JSON body is small and usually covered by description).
  for (const [name, block] of Object.entries(BLOCKS)) {
    const description = block.description ?? "";
    const componentsText = (block.componentsUsed ?? []).join(" ");
    const score = scoreDoc(terms, name, description, componentsText);
    if (score > 0) {
      hits.push({ kind: "block", name, description, score });
    }
  }

  // Examples — name + meta.description.
  for (const [name, example] of Object.entries(EXAMPLES)) {
    const description = extractExampleDescription(example);
    const score = scoreDoc(terms, name, description, "");
    if (score > 0) {
      hits.push({ kind: "example", name, description, score });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function scoreDoc(
  terms: string[],
  name: string,
  description: string,
  body: string,
): number {
  const nameLower = name.toLowerCase();
  const descLower = description.toLowerCase();
  const bodyLower = body.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (nameLower.includes(t)) score += 5;
    if (descLower.includes(t)) score += 3;
    if (bodyLower.includes(t)) {
      // count occurrences in body, capped so one term doesn't dominate
      const count = countOccurrences(bodyLower, t);
      score += Math.min(count, 5);
    }
  }
  return score;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function firstMatchSnippet(body: string, terms: string[]): string | undefined {
  const lower = body.toLowerCase();
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx !== -1) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(body.length, idx + 100);
      const snippet = body.slice(start, end).replace(/\s+/g, " ").trim();
      return (start > 0 ? "…" : "") + snippet + (end < body.length ? "…" : "");
    }
  }
  return undefined;
}

function extractExampleDescription(ex: unknown): string {
  if (
    ex &&
    typeof ex === "object" &&
    "meta" in ex &&
    (ex as { meta?: unknown }).meta &&
    typeof (ex as { meta: Record<string, unknown> }).meta === "object"
  ) {
    const meta = (ex as { meta: Record<string, unknown> }).meta;
    if (typeof meta.description === "string") return meta.description;
  }
  return "";
}
