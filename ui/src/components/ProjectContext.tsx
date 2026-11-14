import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { Project } from "../lib/types";

interface ProjectContextValue {
  projects: Project[];
  project: Project | null;
  projectId: string;
  setProjectId: (id: string) => void;
  isLoading: boolean;
  error: unknown;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);
const STORAGE_KEY = "factory.project";

export function ProjectProvider({ children }: { children: ReactNode }) {
  const query = useQuery({ queryKey: ["projects"], queryFn: api.projects, staleTime: 30_000 });
  const projects = query.data ?? [];
  const [projectId, setProjectIdState] = useState(() => localStorage.getItem(STORAGE_KEY) ?? "");

  const fallback = useMemo(() => {
    const sorted = [...projects].sort(
      (left, right) => (right.time?.active ?? 0) - (left.time?.active ?? 0),
    );
    return sorted[0]?.id ?? "";
  }, [projects]);

  useEffect(() => {
    if (!projects.length) return;
    const exists = projects.some((project) => project.id === projectId);
    if (!exists) setProjectIdState(fallback);
  }, [projects, projectId, fallback]);

  const setProjectId = (id: string) => {
    setProjectIdState(id);
    localStorage.setItem(STORAGE_KEY, id);
  };

  const project = projects.find((item) => item.id === projectId) ?? null;

  return (
    <ProjectContext.Provider
      value={{
        projects,
        project,
        projectId: project?.id ?? projectId,
        setProjectId,
        isLoading: query.isLoading,
        error: query.error,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject debe usarse dentro de ProjectProvider");
  return value;
}
