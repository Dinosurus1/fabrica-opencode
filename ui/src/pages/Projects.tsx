import { useQuery } from "@tanstack/react-query";
import { FolderGit2, GitBranch } from "lucide-react";
import { useProject } from "../components/ProjectContext";
import { Badge, EmptyState, ErrorState, PageHeader, Section, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { formatDate, relativeTime, shortPath } from "../lib/format";

export function ProjectsPage() {
  const { projectId, setProjectId } = useProject();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Projects"
        subtitle="Proyectos conocidos por OpenCode. El proyecto activo se usa para Work, Analytics y el perfil de la fábrica."
      />

      {projects.error ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} /> : null}

      <Section title="Proyectos" description={`${projects.data?.length ?? 0} registrados`}>
        {projects.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : (projects.data?.length ?? 0) === 0 ? (
          <EmptyState icon={<FolderGit2 size={26} />} title="Sin proyectos" description="Abre un repositorio con OpenCode." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="bg-carbon-850">
                <tr>
                  <th className="table-head px-4 py-2.5">Proyecto</th>
                  <th className="table-head px-4 py-2.5">VCS</th>
                  <th className="table-head px-4 py-2.5">Activo</th>
                  <th className="table-head px-4 py-2.5">Creado</th>
                  <th className="table-head px-4 py-2.5">ID</th>
                </tr>
              </thead>
              <tbody>
                {(projects.data ?? []).map((project) => (
                  <tr
                    key={project.id}
                    className="table-row cursor-pointer"
                    onClick={() => setProjectId(project.id)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="grid size-7 place-items-center rounded-md border border-line bg-carbon-800 text-faint">
                          <FolderGit2 size={14} />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-ink">{shortPath(project.canonical)}</div>
                          <div className="truncate font-mono text-[10px] text-faint">{project.canonical}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {project.vcs ? (
                        <Badge>
                          <GitBranch size={11} /> {project.vcs}
                        </Badge>
                      ) : (
                        <span className="text-[11px] text-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[11px] text-muted">
                      {project.time?.active ? relativeTime(project.time.active) : "—"}
                    </td>
                    <td className="px-4 py-3 text-[11px] text-muted">
                      {project.time?.created ? formatDate(project.time.created) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-faint">{project.id.slice(0, 12)}…</span>
                        {project.id === projectId ? <Badge tone="success">activo</Badge> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
