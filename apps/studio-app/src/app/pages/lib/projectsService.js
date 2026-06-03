import { Effect } from "effect";

import { BACKEND_ENABLED } from "../config.js";
import {
  createProjectEffect,
  deleteProjectEffect,
  listProjectsEffect,
  putProjectSpecEffect,
  renameProjectEffect,
} from "./projectsEffects.js";

const randomId = () =>
  `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const today = () => new Date().toISOString().slice(0, 10);

export function normalizeProjects(rows) {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    createdAt: r.created_at ? formatDate(r.created_at) : today(),
    updatedAt: r.updated_at ? formatDate(r.updated_at) : today(),
  }));
}

export function createProjectsService({ auth, mountedRef, runTracked, startDetached }) {
  return {
    startLoad({ setProjects, setLoadError, setIsLoading, toError }) {
      return startDetached(
        listProjectsEffect(auth).pipe(
          Effect.tap((data) =>
            Effect.sync(() => {
              if (!mountedRef.current) return;
              setProjects(normalizeProjects(data?.projects ?? []));
              setLoadError(null);
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              if (mountedRef.current) setLoadError(toError(error));
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (mountedRef.current) setIsLoading(false);
            }),
          ),
        ),
      );
    },

    createProject({ name, description, initialSpec, setProjects }) {
      return runTracked(
        Effect.gen(function* () {
          if (!BACKEND_ENABLED) {
            const project = {
              id: randomId(),
              name: name.trim(),
              description: (description || "").trim(),
              createdAt: today(),
              updatedAt: today(),
              defaultChatId: null,
            };
            if (mountedRef.current) {
              yield* Effect.sync(() => {
                setProjects((prev) => [project, ...prev]);
              });
            }
            return project;
          }

          const res = yield* createProjectEffect(auth, {
            name,
            description: description || "",
          });
          const created = normalizeProjects([res.project])[0];
          created.defaultChatId = res.defaultChatId ?? null;

          if (initialSpec) {
            yield* putProjectSpecEffect(auth, created.id, initialSpec).pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  console.error("[projects] failed to seed initial spec:", error);
                }),
              ),
            );
          }

          if (mountedRef.current) {
            yield* Effect.sync(() => {
              setProjects((prev) => [created, ...prev]);
            });
          }
          return created;
        }),
      );
    },

    renameProject({ id, name, setProjects }) {
      return runTracked(
        Effect.gen(function* () {
          const trimmed = name.trim();
          if (!trimmed) {
            yield* Effect.fail(new Error("name required"));
          }
          if (BACKEND_ENABLED) {
            yield* renameProjectEffect(auth, id, trimmed);
          }
          if (mountedRef.current) {
            yield* Effect.sync(() => {
              setProjects((prev) =>
                prev.map((p) =>
                  p.id === id ? { ...p, name: trimmed, updatedAt: today() } : p,
                ),
              );
            });
          }
        }),
      );
    },

    deleteProject({ id, setProjects }) {
      return runTracked(
        Effect.gen(function* () {
          if (BACKEND_ENABLED) {
            yield* deleteProjectEffect(auth, id);
          }
          if (mountedRef.current) {
            yield* Effect.sync(() => {
              setProjects((prev) => prev.filter((p) => p.id !== id));
            });
          }
        }),
      );
    },
  };
}

function formatDate(ms) {
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return today();
  }
}
