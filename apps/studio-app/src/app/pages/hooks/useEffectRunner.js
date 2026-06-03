import { useCallback, useEffect, useRef } from "react";
import { Effect, Fiber } from "effect";

export function useEffectRunner() {
  const mountedRef = useRef(true);
  const activeFibersRef = useRef(new Set());

  const releaseFiber = useCallback((fiber) => {
    activeFibersRef.current.delete(fiber);
  }, []);

  const runTracked = useCallback(
    (effect) => {
      const fiber = Effect.runFork(effect);
      activeFibersRef.current.add(fiber);
      return Effect.runPromise(
        Fiber.join(fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              releaseFiber(fiber);
            }),
          ),
        ),
      );
    },
    [releaseFiber],
  );

  const runDetached = useCallback(
    (effect) => {
      const fiber = Effect.runFork(effect);
      activeFibersRef.current.add(fiber);
      Effect.runFork(
        Fiber.await(fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              releaseFiber(fiber);
            }),
          ),
          Effect.asVoid,
        ),
      );
      return fiber;
    },
    [releaseFiber],
  );

  const startDetached = useCallback(
    (effect) => {
      const fiber = runDetached(effect);
      return () => {
        releaseFiber(fiber);
        Effect.runFork(Fiber.interrupt(fiber));
      };
    },
    [releaseFiber, runDetached],
  );

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      for (const fiber of activeFibersRef.current) {
        Effect.runFork(Fiber.interrupt(fiber));
      }
      activeFibersRef.current.clear();
    };
  }, []);

  return {
    mountedRef,
    runTracked,
    runDetached,
    startDetached,
  };
}
