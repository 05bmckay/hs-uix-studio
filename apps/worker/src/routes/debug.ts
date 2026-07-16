import { Hono } from "hono";
import type { Env } from "../index";

export const debugRoutes = new Hono<{ Bindings: Env }>();

const MODEL = "@cf/moonshotai/kimi-k2.6";

debugRoutes.get("/kimi", async (c) => {
  const q = c.req.query("q") ?? "Say hi in 3 words.";
  const started = Date.now();
  const r = await c.env.AI.run(MODEL, {
    messages: [
      { role: "system", content: "Reply in one short sentence." },
      { role: "user", content: q },
    ],
  });
  return c.json({ ms: Date.now() - started, model: MODEL, response: r });
});

// Probe tool-use response shape. No real tools executed — we just want to see
// what Workers AI returns when the model decides to call a tool, so we know
// the target shape for any future chat-stream refactor.
debugRoutes.get("/kimi-tools", async (c) => {
  const q = c.req.query("q") ?? "What's the weather in Paris?";
  const started = Date.now();
  const r = await c.env.AI.run(MODEL, {
    messages: [
      { role: "user", content: q },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
      },
    ],
    // Deliberate shape probe with non-standard fields; `never` satisfies
    // every overload of the (now stricter) AI.run typings.
  } as never);
  return c.json({ ms: Date.now() - started, model: MODEL, response: r });
});
