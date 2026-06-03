import { Effect } from "effect";

import { workerApi } from "./worker.js";

export const listProjectsEffect = (auth) =>
  Effect.tryPromise(() => workerApi.listProjects(auth));

export const createProjectEffect = (auth, { name, description }) =>
  Effect.tryPromise(() =>
    workerApi.createProject(auth, {
      name,
      description,
    }),
  );

export const putProjectSpecEffect = (auth, projectId, spec) =>
  Effect.tryPromise(() => workerApi.putSpec(auth, projectId, spec));

export const renameProjectEffect = (auth, projectId, name) =>
  Effect.tryPromise(() => workerApi.patchProject(auth, projectId, { name }));

export const deleteProjectEffect = (auth, projectId) =>
  Effect.tryPromise(() => workerApi.deleteProject(auth, projectId));
