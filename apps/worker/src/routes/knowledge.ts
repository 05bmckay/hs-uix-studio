// Public-to-the-extension catalog of prebuilt blocks and example cards.
// The same data the LLM sees via read_block / read_example tools, exposed
// as HTTP so the Studio app's home page can render browsable grids.
//
// Still gated by requireInstall because every other route is — the content
// isn't secret, but the worker shouldn't accept unauthenticated calls.

import { Hono } from "hono";
import type { Env } from "../index";
import { requireInstall } from "../lib/verify";
import { BLOCKS, EXAMPLES } from "../tools/knowledge";

export const knowledgeRoutes = new Hono<{ Bindings: Env }>();

// GET /knowledge/catalog → { blocks: [...summary], examples: [...summary] }
// Summary shape is intentionally small so the home page can render without
// a second round-trip per item. Full node/spec comes from the detail routes.
knowledgeRoutes.get("/catalog", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  // Blocks are small (~1KB each), so we inline the full node + dataShape
  // into the catalog response. That lets the home-page preview modal render
  // the block without a second round-trip when the user clicks "Preview".
  const blocks = Object.entries(BLOCKS).map(([name, block]) => ({
    name,
    description: block.description ?? "",
    componentsUsed: block.componentsUsed ?? [],
    dataShape: block.dataShape ?? null,
    initialState: (block as { initialState?: unknown }).initialState ?? null,
    node: block.node,
  }));

  // Full example specs inline — 6 examples at ~10KB each (~65KB total) is a
  // cheap price to pay so the home-page Preview modal can render the card
  // without a second round-trip. Keeps the "clicks feel instant" UX.
  const examples = Object.entries(EXAMPLES).map(([name, spec]) => {
    const meta = (spec as { meta?: Record<string, unknown> })?.meta ?? {};
    return {
      name,
      displayName: typeof meta.name === "string" ? meta.name : name,
      // tagline = short one-liner for the home-page tile. description =
      // long detailed summary for the LLM's search_knowledge ranking. Keep
      // both; the UI picks tagline, the LLM gets description.
      tagline: typeof meta.tagline === "string" ? meta.tagline : null,
      description: typeof meta.description === "string" ? meta.description : "",
      surface: typeof meta.surface === "string" ? meta.surface : null,
      object: typeof meta.object === "string" ? meta.object : null,
      spec,
    };
  });

  return c.json({ blocks, examples });
});

// GET /knowledge/blocks/:name → full block JSON (name, description, node, ...)
knowledgeRoutes.get("/blocks/:name", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const name = c.req.param("name");
  const block = BLOCKS[name];
  if (!block) return c.json({ error: "not_found" }, 404);
  return c.json(block);
});

// GET /knowledge/examples/:name → full example spec
knowledgeRoutes.get("/examples/:name", async (c) => {
  const caller = await requireInstall(c);
  if (caller instanceof Response) return caller;

  const name = c.req.param("name");
  const spec = EXAMPLES[name];
  if (!spec) return c.json({ error: "not_found" }, 404);
  return c.json(spec);
});
