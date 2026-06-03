import { Effect } from "effect";

import { workerApi } from "./worker.js";

export const getKnowledgeCatalogEffect = (auth) =>
  Effect.tryPromise(() => workerApi.getKnowledgeCatalog(auth));

export const createProjectWithTemplateEffect = (
  createProject,
  { name, description, initialSpec },
) => Effect.tryPromise(() => createProject({ name, description, initialSpec }));
