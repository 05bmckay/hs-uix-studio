import { Effect } from "effect";

import { workerApi, WorkerError } from "./worker.js";

function toEffectError(error) {
  if (error instanceof WorkerError) return error;
  return error instanceof Error ? error : new Error(String(error));
}

export const getDesignDocEffect = (auth, projectId) =>
  Effect.tryPromise({
    try: () => workerApi.getDesignDoc(auth, projectId),
    catch: (error) => toEffectError(error),
  });

export const generateDesignDocEffect = (auth, projectId, { regenerate }) =>
  Effect.tryPromise({
    try: () => workerApi.generateDesignDoc(auth, projectId, { regenerate }),
    catch: (error) => toEffectError(error),
  });
