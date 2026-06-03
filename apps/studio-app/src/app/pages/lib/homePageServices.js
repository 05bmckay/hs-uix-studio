import { Effect } from "effect";

import {
  createProjectWithTemplateEffect,
  getKnowledgeCatalogEffect,
} from "./homePageEffects.js";

export function createHomePageService({
  auth,
  createProjectFn,
  mountedRef,
  navigateToPage,
  runTracked,
  startDetached,
}) {
  return {
    startCatalogLoad({ setCatalog, setCatalogError }) {
      return startDetached(
        getKnowledgeCatalogEffect(auth).pipe(
          Effect.tap((data) =>
            Effect.sync(() => {
              if (!mountedRef.current) return;
              setCatalog(data);
              setCatalogError(null);
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              if (mountedRef.current) setCatalogError(error);
            }),
          ),
        ),
      );
    },

    async useTemplate({ example, setTemplatingName }) {
      if (!example) return;
      setTemplatingName(example.name);
      try {
        const project = await runTracked(
          createProjectWithTemplateEffect(createProjectFn, {
            name: example.displayName || example.name,
            description: example.description || "",
            initialSpec: example.spec,
          }),
        );
        if (!mountedRef.current) return;
        navigateToPage(project.id);
      } catch (error) {
        console.error("[home] use-as-template failed:", error);
      } finally {
        if (mountedRef.current) setTemplatingName(null);
      }
    },

    async createProject({
      name,
      description,
      setIsCreating,
      resetDrafts,
    }) {
      setIsCreating(true);
      try {
        const project = await runTracked(
          createProjectWithTemplateEffect(createProjectFn, {
            name,
            description,
            initialSpec: undefined,
          }),
        );
        if (!mountedRef.current) return;
        resetDrafts();
        navigateToPage(project.id);
      } catch (error) {
        console.error("[home] create failed:", error);
      } finally {
        if (mountedRef.current) setIsCreating(false);
      }
    },
  };
}
