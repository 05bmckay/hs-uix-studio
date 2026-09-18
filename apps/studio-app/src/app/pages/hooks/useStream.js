import { useEffect, useRef, useState } from "react";
import { Duration, Effect, Fiber } from "effect";
import { hubspot, logger } from "@hubspot/ui-extensions";

// Polls the worker's /streams/:id endpoint at a fixed interval while the
// stream is producing tokens. Calls onChunk(append, nextOffset) every tick
// that returns new text, and onDone(finalText, usage) when status flips to
// "done". onError fires on status === "error" or persistent network failure.
//
// Uses hubspot.fetch so HubSpot can attach portal context headers that the
// worker verifies. Extension side doesn't construct auth itself.
//
// Stall handling: if the offset hasn't advanced for STALE_RESYNC_MS while
// status === "streaming", the next poll re-fetches with `since=0` to force
// a full resync against the server's current buffer. This recovers from the
// case where the Durable Object was evicted and rehydrated from storage —
// the rehydrated content matches what the client has, so the resync is a
// no-op cost; if the server has tokens the client missed, they're delivered
// as a single trailing append.
//
// Transient fetch errors retry MAX_FETCH_RETRIES times with linear backoff
// before surfacing onError. A single network blip used to kill the poll
// loop permanently and force a page reload to recover.
//
// Usage:
//   const { isStreaming } = useStream({
//     workerUrl: WORKER_URL,
//     streamId,         // from POST /chat response
//     intervalMs: 400,  // optional, default 400
//     enabled: Boolean(streamId),
//     onChunk: (append, nextOffset) => { ... },
//     onDone: (finalText, usage) => { ... },
//     onError: (err) => { ... },
//   });
const STALE_RESYNC_MS = 3000;
// Dead-stream detection. We used to trip on "no user-visible text advance",
// but big tool_use JSON can go 30–60s without any text delta (emit_spec /
// patch_spec), so that was false-flagging live generation. Now we trust
// the server-reported `lastEventAt` — bumped on EVERY Anthropic event,
// including tool_use deltas. If the server hasn't seen an event in
// SERVER_STALL_FAIL_MS, the run is genuinely dead (DO evicted, SDK crashed).
const SERVER_STALL_FAIL_MS = 90000;
// When the client hasn't seen a token advance for this long but the server
// still reports `streaming`, surface a "Reconnecting…" affordance so the user
// knows we're aware of the gap. Distinct from the server-stall failure: the
// server may still be live (e.g. a long tool_use), but the HubSpot fetch
// proxy has dropped intermediate polls. We resync via since=0 anyway; this
// is purely a UX hint.
const RECONNECTING_THRESHOLD_MS = 2.5 * 60 * 1000;
const MAX_FETCH_RETRIES = 5;
// hubspot.fetch goes through the host page's postMessage proxy, which can
// drop a call without ever settling the promise. The poll loop is strictly
// sequential, so an unsettled fetch would freeze it permanently — the UI
// keeps showing "streaming" while nothing arrives and only a reload
// recovers. Cap every poll so a dropped call becomes a retryable error.
const POLL_FETCH_TIMEOUT_MS = 15000;
const POLL_BODY_TIMEOUT_MS = 5000;

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function runHandler(ref, ...args) {
  return Effect.sync(() => {
    ref.current?.(...args);
  });
}

function setStreamUi({ setIsStreaming, setPhase, setPhaseHistory, setReconnecting }, next) {
  return Effect.sync(() => {
    if (typeof next.isStreaming === "boolean") {
      setIsStreaming(next.isStreaming);
    }
    if (typeof next.phase === "string") {
      setPhase(next.phase);
    }
    if (Array.isArray(next.phaseHistory)) {
      setPhaseHistory(next.phaseHistory);
    }
    if (typeof next.reconnecting === "boolean") {
      setReconnecting(next.reconnecting);
    }
  });
}

function createStreamProgram({
  workerUrl,
  streamId,
  intervalMs,
  onChunkRef,
  onDoneRef,
  onErrorRef,
  onSpecRef,
  onPatchesRef,
  setIsStreaming,
  setPhase,
  setPhaseHistory,
  setReconnecting,
  isCancelled,
}) {
  let offset = 0;
  let lastAdvanceAt = Date.now();
  let retries = 0;
  let lastSpecVersion = 0;
  // Phase-2 patch cursor: -1 means "not subscribed" — request 0 on the first
  // poll to opt in. Bumped to the server's nextCursor each tick.
  let patchesCursor = onPatchesRef.current ? 0 : null;

  const stopStreaming = (phase = "") =>
    setStreamUi(
      { setIsStreaming, setPhase, setPhaseHistory, setReconnecting },
      { isStreaming: false, phase, reconnecting: false },
    );

  const pollOnce = Effect.gen(function* () {
    if (isCancelled()) return { done: true, delayMs: null };

    const stale = Date.now() - lastAdvanceAt > STALE_RESYNC_MS;
    const sinceParam = stale ? 0 : offset;
    const patchesParam = patchesCursor != null ? `&patchesSince=${patchesCursor}` : "";
    const res = yield* Effect.tryPromise(() =>
      hubspot.fetch(
        `${workerUrl}/streams/${streamId}?since=${sinceParam}${patchesParam}`,
        { method: "GET" },
      ),
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(POLL_FETCH_TIMEOUT_MS),
        onTimeout: () => new Error("stream poll fetch timed out"),
      }),
    );

    if (isCancelled()) return { done: true, delayMs: null };
    if (!res.ok) {
      return yield* Effect.fail(new Error(`stream poll ${res.status}`));
    }

    const data = yield* Effect.tryPromise(() => res.json()).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(POLL_BODY_TIMEOUT_MS),
        onTimeout: () => new Error("stream poll body timed out"),
      }),
    );
    if (isCancelled()) return { done: true, delayMs: null };

    retries = 0;

    if (typeof data.phase === "string") {
      yield* setStreamUi(
        { setIsStreaming, setPhase, setPhaseHistory, setReconnecting },
        { phase: data.phase },
      );
    }
    if (Array.isArray(data.phaseHistory)) {
      yield* setStreamUi(
        { setIsStreaming, setPhase, setPhaseHistory, setReconnecting },
        { phaseHistory: data.phaseHistory },
      );
    }

    if (stale && typeof data.nextOffset === "number") {
      if (data.nextOffset > offset) {
        const tail =
          typeof data.append === "string" ? data.append.slice(offset) : "";
        offset = data.nextOffset;
        if (tail.length > 0) {
          lastAdvanceAt = Date.now();
          yield* runHandler(onChunkRef, tail, offset);
        }
      }
    } else if (data.append && data.append.length > 0) {
      offset = data.nextOffset;
      lastAdvanceAt = Date.now();
      yield* runHandler(onChunkRef, data.append, offset);
    } else if (typeof data.nextOffset === "number") {
      offset = data.nextOffset;
    }

    if (
      typeof data.specVersion === "number" &&
      data.specVersion > lastSpecVersion &&
      data.spec
    ) {
      lastSpecVersion = data.specVersion;
      yield* runHandler(onSpecRef, data.spec, data.specNote ?? null);
    }

    // Phase-2: deliver new patches, advance cursor. Full-spec replacement
    // above stays as the authoritative safety net — patches are the
    // progressive preview path.
    if (patchesCursor != null && data.patches && Array.isArray(data.patches.log)) {
      if (data.patches.log.length > 0) {
        yield* runHandler(onPatchesRef, data.patches.log);
      }
      if (typeof data.patches.nextCursor === "number") {
        patchesCursor = data.patches.nextCursor;
      }
    }

    if (data.status === "streaming") {
      const reconnecting =
        Date.now() - lastAdvanceAt > RECONNECTING_THRESHOLD_MS;
      yield* setStreamUi(
        { setIsStreaming, setPhase, setPhaseHistory, setReconnecting },
        { reconnecting },
      );
    } else {
      yield* setStreamUi(
        { setIsStreaming, setPhase, setPhaseHistory, setReconnecting },
        { reconnecting: false },
      );
    }

    if (
      data.status === "streaming" &&
      typeof data.lastEventAt === "number" &&
      typeof data.serverNow === "number" &&
      data.serverNow - data.lastEventAt > SERVER_STALL_FAIL_MS
    ) {
      logger.warn(
        `[useStream] server stall: stream=${streamId} phase=${data.phase ?? ""} ` +
          `idleMs=${data.serverNow - data.lastEventAt} offset=${offset} ` +
          `sinceClientAdvanceMs=${Date.now() - lastAdvanceAt}`,
      );
      yield* stopStreaming("");
      yield* runHandler(onErrorRef, new Error("stream stalled"));
      return { done: true, delayMs: null };
    }

    if (data.status === "done") {
      yield* stopStreaming("");
      yield* runHandler(onDoneRef, data);
      return { done: true, delayMs: null };
    }

    if (data.status === "error") {
      logger.error(
        `[useStream] worker error: stream=${streamId} error=${data.error || "stream error"}`,
      );
      yield* stopStreaming("");
      yield* runHandler(onErrorRef, new Error(data.error || "stream error"));
      return { done: true, delayMs: null };
    }

    return { done: false, delayMs: intervalMs };
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        if (isCancelled()) return { done: true, delayMs: null };
        if (retries < MAX_FETCH_RETRIES) {
          retries += 1;
          logger.debug(
            `[useStream] poll retry ${retries}/${MAX_FETCH_RETRIES}: stream=${streamId} ` +
              `error=${toError(error).message} offset=${offset}`,
          );
          return {
            done: false,
            delayMs: intervalMs * (retries + 1),
          };
        }
        logger.warn(
          `[useStream] poll gave up after ${retries} retries: stream=${streamId} ` +
            `error=${toError(error).message} offset=${offset} ` +
            `sinceClientAdvanceMs=${Date.now() - lastAdvanceAt}`,
        );
        yield* stopStreaming("");
        yield* runHandler(onErrorRef, toError(error));
        return { done: true, delayMs: null };
      }),
    ),
  );

  return Effect.gen(function* () {
    while (!isCancelled()) {
      const result = yield* pollOnce;
      if (result.done || result.delayMs == null) return;
      yield* Effect.sleep(Duration.millis(result.delayMs));
    }
  });
}

export function useStream({
  workerUrl,
  streamId,
  intervalMs = 400,
  enabled = true,
  onChunk,
  onDone,
  onError,
  onSpec,
  onPatches,
}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [phase, setPhase] = useState("");
  const [phaseHistory, setPhaseHistory] = useState([]);
  const [reconnecting, setReconnecting] = useState(false);
  // Refs so the interval callback doesn't retrigger when handlers change.
  const onChunkRef = useRef(onChunk);
  const onDoneRef = useRef(onDone);
  const onErrorRef = useRef(onError);
  const onSpecRef = useRef(onSpec);
  const onPatchesRef = useRef(onPatches);
  useEffect(() => {
    onChunkRef.current = onChunk;
    onDoneRef.current = onDone;
    onErrorRef.current = onError;
    onSpecRef.current = onSpec;
    onPatchesRef.current = onPatches;
  });

  useEffect(() => {
    if (!enabled || !streamId || !workerUrl) return undefined;

    let cancelled = false;
    logger.debug(
      `[useStream] subscribe: stream=${streamId} intervalMs=${intervalMs}`,
    );
    setIsStreaming(true);
    setPhase("Thinking");
    setPhaseHistory([]);
    setReconnecting(false);

    const fiber = Effect.runFork(
      createStreamProgram({
        workerUrl,
        streamId,
        intervalMs,
        onChunkRef,
        onDoneRef,
        onErrorRef,
        onSpecRef,
        onPatchesRef,
        setIsStreaming,
        setPhase,
        setPhaseHistory,
        setReconnecting,
        isCancelled: () => cancelled,
      }),
    );

    return () => {
      cancelled = true;
      Effect.runFork(Fiber.interrupt(fiber));
      setIsStreaming(false);
      setPhase("");
      setReconnecting(false);
    };
  }, [workerUrl, streamId, intervalMs, enabled]);

  return { isStreaming, phase, phaseHistory, reconnecting };
}
