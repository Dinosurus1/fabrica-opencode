import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useProject } from "../components/ProjectContext";
import { Badge, EmptyState, ErrorState, PageHeader, Section, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { shortPath } from "../lib/format";

export function SkillsPage() {
  const { project } = useProject();
  const directory = project?.canonical;
  const [search, setSearch] = useState("");
  const skills = useQuery({
    queryKey: ["opencode", "skills", directory ?? "default"],
    queryFn: () => api.skills(directory),
  });

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = skills.data ?? [];
    if (!term) return list;
    return list.filter((skill) =>
      [skill.id, skill.name, skill.description, skill.path]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term)),
    );
  }, [skills.data, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Skills"
        subtitle="Conocimiento especializado disponible bajo demanda. Cada skill se carga solo cuando la tarea la necesita."
        actions={
          <input
            className="field h-8 w-64 text-xs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filtrar skills..."
          />
        }
      />

      {skills.error ? <ErrorState error={skills.error} onRetry={() => void skills.refetch()} /> : null}

      <Section title="Catálogo" description={`${filtered.length} de ${skills.data?.length ?? 0} skills`}>
        {skills.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={<Sparkles size={26} />} title="Sin skills" description="No hay skills para el filtro actual." />
        ) : (
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((skill) => (
              <article key={skill.id} className="rounded-lg border border-line-soft bg-carbon-950/50 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-xs font-semibold text-ink">{skill.name}</h3>
                    <div className="font-mono text-[10px] text-faint">{skill.id}</div>
                  </div>
                  {skill.path?.startsWith("/builtin/") ? <Badge tone="violet">builtin</Badge> : <Badge>local</Badge>}
                </div>
                <p className="mt-2 line-clamp-3 text-[11px] leading-5 text-muted">{skill.description ?? "Sin descripción."}</p>
                <div className="mt-2 truncate font-mono text-[10px] text-faint">{shortPath(skill.path)}</div>
              </article>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
