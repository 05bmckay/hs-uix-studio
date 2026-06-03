import { Hono } from "hono";
import type { Env } from "../index";

export const streamRoutes = new Hono<{ Bindings: Env }>();

// GET /streams/:id?since=<char_offset>
// Proxies to Stream Relay, which holds the in-progress Agent response in
// memory. Returns:
//   { status: "streaming" | "done" | "error",
//     append: string,        // bytes of content past `since`
//     nextOffset: number,
//     usage?: { input_tokens, output_tokens, model } }
// Dispatch by streamId prefix: `export:…` → ExportStream DO, everything else
// → Stream Relay. Export streams still use the legacy poll protocol; chat
// streams now use @hs-uix/stream-relay behind the same /streams/:id URL.
function getExportStub(env: Env, streamId: string): DurableObjectStub {
  return env.EXPORT_STREAM.get(env.EXPORT_STREAM.idFromName(streamId));
}

function getRelayStub(env: Env, streamId: string): DurableObjectStub {
  return env.RELAY.get(env.RELAY.idFromName(streamId));
}

streamRoutes.get("/:id", async (c) => {
  const streamId = c.req.param("id");
  const since = Number(c.req.query("since") ?? 0);
  if (streamId.startsWith("export:")) {
    const patchesSince = c.req.query("patchesSince");
    const stub = getExportStub(c.env, streamId);

    const url = new URL("https://do/poll");
    url.searchParams.set("since", String(since));
    if (patchesSince != null) {
      url.searchParams.set("patchesSince", patchesSince);
    }
    return stub.fetch(url.toString());
  }

  const eventSince = c.req.query("eventSince") ?? c.req.query("patchesSince") ?? "0";
  const stub = getRelayStub(c.env, streamId);
  const response = await stub.fetch(
    `https://relay/poll?id=${encodeURIComponent(streamId)}&since=${encodeURIComponent(
      String(since),
    )}&eventSince=${encodeURIComponent(eventSince)}`,
  );
  const relay = (await response.json()) as {
    status: "streaming" | "complete" | "error" | "not_found";
    append?: string;
    nextOffset?: number;
    events?: Array<Record<string, unknown>>;
    nextEventOffset?: number;
    progress?: { message?: string; data?: { phaseHistory?: string[] } };
    lastEventAt?: number;
    serverNow?: number;
    error?: string;
    final?: { meta?: Record<string, unknown> };
  };

  const specEvent = [...(relay.events ?? [])]
    .reverse()
    .find((event) => event.type === "spec.snapshot");
  const patchLog = (relay.events ?? []).flatMap((event) =>
    event.type === "spec.patches" && Array.isArray(event.patches)
      ? event.patches
      : [],
  );
  const finalMeta = relay.final?.meta;

  return c.json({
    status:
      relay.status === "complete"
        ? "done"
        : relay.status === "not_found"
          ? "error"
          : relay.status,
    append: relay.append ?? "",
    nextOffset: relay.nextOffset ?? since,
    phase: relay.progress?.message,
    phaseHistory: relay.progress?.data?.phaseHistory ?? [],
    lastEventAt: relay.lastEventAt,
    serverNow: relay.serverNow,
    error: relay.error ?? (relay.status === "not_found" ? "stream not found" : undefined),
    usage: finalMeta?.usage,
    spec: specEvent?.spec ?? finalMeta?.spec,
    specVersion: specEvent?.specVersion ?? finalMeta?.specVersion,
    specNote: specEvent?.note ?? finalMeta?.specNote,
    questions: finalMeta?.questions,
    patches: {
      log: patchLog,
      nextCursor: relay.nextEventOffset ?? Number(eventSince),
    },
  });
});

// GET /streams/:id/diagnostic — full state dump for a live or recently-ended
// stream. Intended for debugging ("why did that turn stall?") — not part of
// the polled-UI path. Bypasses install-verification so curl works locally.
// Legacy diagnostic endpoint for export streams only. Chat streams are relay-backed.
streamRoutes.get("/:id/diagnostic", async (c) => {
  const streamId = c.req.param("id");
  if (!streamId.startsWith("export:")) {
    return c.json({ error: "diagnostic_unavailable_for_relay_streams" }, 404);
  }
  const stub = getExportStub(c.env, streamId);
  return stub.fetch("https://do/diagnostic");
});
