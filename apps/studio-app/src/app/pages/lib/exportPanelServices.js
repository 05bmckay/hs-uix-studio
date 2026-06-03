import { Effect } from "effect";

import {
  generateDesignDocEffect,
  getDesignDocEffect,
} from "./exportPanelEffects.js";
import { WorkerError } from "./worker.js";

export function createExportPanelService({
  auth,
  projectId,
  mountedRef,
  runTracked,
  startDetached,
}) {
  return {
    startDocLoad({
      canUseBackend,
      docFetched,
      setDocLoading,
      setDocState,
      setDocFetched,
      setStreamingId,
      setStreamingMarkdown,
    }) {
      if (!canUseBackend || docFetched) return undefined;
      setDocLoading(true);
      let reattached = false;
      return startDetached(
        getDesignDocEffect(auth, projectId).pipe(
          Effect.tap((res) =>
            Effect.sync(() => {
              if (!mountedRef.current) return;
              setDocState(res ?? null);
              // If the worker reports a fresh in-flight export stream, reattach
              // so the skeleton + live buffer pick up where they left off after
              // a page reload. Leave docLoading true; useStream clears it.
              if (res?.active_stream_id) {
                reattached = true;
                setStreamingMarkdown?.("");
                setStreamingId?.(res.active_stream_id);
              }
            }),
          ),
          Effect.catchAll(() =>
            Effect.sync(() => {
              if (!mountedRef.current) return;
              setDocState(null);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (!mountedRef.current) return;
              setDocFetched(true);
              if (!reattached) setDocLoading(false);
            }),
          ),
        ),
      );
    },

    // Kicks off generation. Two outcomes:
    //   - Cache hit → { cached: true, markdown, updated_at }. We write it to
    //     docState and clear loading. Setters for streaming aren't touched.
    //   - Miss → { cached: false, streamId }. We set streamingId; the panel's
    //     useStream hook takes over, appends chunks to streamingMarkdown, and
    //     on done flips docState + clears streamingId. `setDocLoading` stays
    //     true the whole time — the stream hook clears it when done/errors.
    async generateDesignDoc({
      canUseBackend,
      regenerate = false,
      setDocLoading,
      setGenError,
      setDocState,
      setStreamingMarkdown,
      setStreamingId,
    }) {
      if (!canUseBackend) return;
      setDocLoading(true);
      setGenError(null);
      setStreamingMarkdown?.("");
      setStreamingId?.(null);
      try {
        const res = await runTracked(generateDesignDocEffect(auth, projectId, { regenerate }));
        if (!mountedRef.current) return;
        if (res?.cached) {
          setDocState((prev) => ({
            ...(prev ?? {}),
            markdown: res.markdown ?? "",
            updated_at: res.updated_at ?? Date.now(),
            stale: false,
            has_spec: true,
          }));
          setDocLoading(false);
          return;
        }
        if (res?.streamId) {
          setStreamingId?.(res.streamId);
          // Loading stays true; the panel's useStream handler clears it.
          return;
        }
        // Unexpected shape — surface something rather than hanging.
        setGenError("unexpected server response");
        setDocLoading(false);
      } catch (error) {
        if (!mountedRef.current) return;
        setGenError(toMessage(error));
        setDocLoading(false);
      }
    },
  };
}

function toMessage(err) {
  if (err instanceof WorkerError) return `${err.code}: ${err.message}`;
  return err?.message ?? String(err);
}
