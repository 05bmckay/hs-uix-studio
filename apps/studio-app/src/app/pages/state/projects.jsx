import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useExtensionApi } from "@hubspot/ui-extensions";

import { BACKEND_ENABLED } from "../config.js";
import { WorkerError } from "../lib/worker.js";
import { useEffectRunner } from "../hooks/useEffectRunner.js";
import { createProjectsService } from "../lib/projectsService.js";

// Projects state. Two code paths behind one hook:
//   - Worker-backed (when BACKEND_ENABLED): loads/creates via the Cloudflare
//     worker. Survives reload because it's real storage.
//   - In-memory (fallback): dev/no-backend mode, seeded with one demo row.
//
// createProject returns the created record so HomePage can navigate into it.
// In worker mode it awaits the server round-trip so the returned id is the
// real one. The server also creates a default chat thread which we expose as
// defaultChatId on the returned record.

const ProjectsContext = createContext(null);

const SEED_PROJECTS = [
  {
    id: "demo-construction-delays",
    name: "Construction Delays",
    description:
      "Schedule slippage, delay causes, planned vs actual progress for a deal.",
    createdAt: "2026-04-20",
    updatedAt: "2026-04-22",
  },
];

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

export const ProjectsProvider = ({ children }) => {
  const [projects, setProjects] = useState(BACKEND_ENABLED ? [] : SEED_PROJECTS);
  const [isLoading, setIsLoading] = useState(BACKEND_ENABLED);
  const [loadError, setLoadError] = useState(null);
  const { mountedRef, runTracked, startDetached } = useEffectRunner();

  const api = useExtensionApi();
  const auth = useMemo(
    () => ({
      hubId:
        api?.context?.portal?.id ??
        api?.context?.portalId ??
        api?.hubSpotUser?.portal?.id ??
        null,
      userId:
        api?.context?.user?.id ??
        api?.hubSpotUser?.id ??
        null,
    }),
    [api],
  );
  const projectsService = useMemo(
    () => createProjectsService({ auth, mountedRef, runTracked, startDetached }),
    [auth, mountedRef, runTracked, startDetached],
  );

  // Initial load from the worker. Empty list if not installed yet.
  useEffect(() => {
    if (!BACKEND_ENABLED) return;
    return projectsService.startLoad({
      setProjects,
      setLoadError,
      setIsLoading,
      toError,
    });
  }, [auth.hubId, auth.userId, projectsService]);

  const createProject = useCallback(
    async ({ name, description, initialSpec }) => {
      return projectsService.createProject({
        name,
        description,
        initialSpec,
        setProjects,
      });
    },
    [projectsService],
  );

  const getProject = useCallback(
    (id) => projects.find((p) => p.id === id),
    [projects],
  );

  const renameProject = useCallback(
    async (id, name) => {
      return projectsService.renameProject({ id, name, setProjects });
    },
    [projectsService],
  );

  const deleteProject = useCallback(
    async (id) => {
      return projectsService.deleteProject({ id, setProjects });
    },
    [projectsService],
  );

  const value = {
    projects,
    isLoading,
    loadError,
    createProject,
    getProject,
    renameProject,
    deleteProject,
    auth,
  };
  return (
    <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>
  );
};

export const useProjects = () => {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error("useProjects must be used within ProjectsProvider");
  return ctx;
};

// Re-export so callers that need raw errors can distinguish from generic ones.
export { WorkerError };
