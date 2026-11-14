import { useQuery } from "@tanstack/react-query";
import { Bot, Cpu, Lock, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { useProject } from "../components/ProjectContext";
import { Badge, EmptyState, ErrorState, PageHeader, Section, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { formatCompact } from "../lib/format";
import { rpc } from "../lib/rpc";
import type { AgentInfo, CatalogAgent, Profile } from "../lib/types";

export function AgentsPage() {
  const { project } = useProject();
  const directory = project?.canonical;
  const [search, setSearch] = useState("");
  const catalog = useQuery({
    queryKey: ["factory", "agents", directory ?? "default"],
    queryFn: () => rpc<{ count: number; agents: CatalogAgent[] }>("agents.list", {}, directory),
  });
  const profiles = useQuery({
    queryKey: ["factory", "profiles", directory ?? "default"],
    queryFn: () => rpc<{ count: number; profiles: Profile[]; applied_profile_id?: string | null }>("profiles.list", {}, directory),
  });
  const defaultProfile = profiles.data?.profiles.find((profile) => profile.isDefault) ?? null;
  const appliedProfile =
    profiles.data?.profiles.find((profile) => profile.id === profiles.data?.applied_profile_id) ?? null;
  const activeProfile = appliedProfile ?? defaultProfile;
  const profile = useQuery({
    queryKey: ["factory", "profile", activeProfile?.id, directory ?? "default"],
    queryFn: () => rpc<Profile>("profiles.get", { id: activeProfile!.id }, directory),
    enabled: Boolean(activeProfile?.id),
  });
  const live = useQuery({ queryKey: ["opencode", "agents", directory ?? "default"], queryFn: () => api.agents(directory) });

  const rows = useMemo(() => {
    const catalogById = new Map((catalog.data?.agents ?? []).map((agent) => [agent.agentId, agent]));
    const liveById = new Map((live.data ?? []).map((agent) => [agent.id, agent]));
    const assignments = new Map(
      (profile.data?.assignments ?? []).map((assignment) => [
        assignment.agentId,
        `${assignment.providerId}/${assignment.modelId}`,
      ]),
    );
    const ids = new Set([...catalogById.keys(), ...liveById.keys()]);
    return [...ids]
      .map((id) => {
        const catalogAgent = catalogById.get(id);
        const liveAgent = liveById.get(id);
        return {
          id,
          name: liveAgent?.name ?? catalogAgent?.name ?? id,
          role: catalogAgent?.role ?? "—",
          mode: liveAgent?.mode ?? catalogAgent?.mode ?? "—",
          description: liveAgent?.description ?? catalogAgent?.description ?? "",
          currentModel: liveAgent?.model
            ? `${liveAgent.model.providerID}/${liveAgent.model.id}`
            : catalogAgent?.modelProvider && catalogAgent?.modelId
              ? `${catalogAgent.modelProvider}/${catalogAgent.modelId}`
              : null,
          assignedModel: assignments.get(id) ?? null,
          permissions: catalogAgent?.permissions?.length ?? liveAgent?.permissions?.length ?? 0,
          steps: liveAgent?.steps ?? catalogAgent?.steps ?? null,
          lastSeenAt: catalogAgent?.lastSeenAt,
        };
      })
      .filter((agent) => agent.id && (agent.currentModel || agent.assignedModel))
      .filter((agent) => {
        const term = search.trim().toLowerCase();
        if (!term) return true;
        return [agent.id, agent.name, agent.role, agent.currentModel, agent.assignedModel]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term));
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }, [catalog.data, live.data, profile.data, search]);

  const error = catalog.error ?? profiles.error ?? profile.error ?? live.error;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agents"
        subtitle="Catálogo de subagentes y modelos activos. El modelo se asigna por perfil en Models; aquí solo se audita el estado."
        actions={
          <>
            <Badge tone={activeProfile ? (appliedProfile ? "violet" : "success") : "warning"}>
              <ShieldCheck size={12} /> {activeProfile?.name ?? "sin perfil por defecto"}
              {appliedProfile ? " · aplicado" : ""}
            </Badge>
            <input
              className="field h-8 w-56 text-xs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filtrar agentes..."
            />
          </>
        }
      />

      {error ? <ErrorState error={error} onRetry={() => void catalog.refetch()} /> : null}

      <Section
        title="Subagentes"
        description={`${rows.length} agentes con modelo o perfil asignado. Un cambio de modelo no altera permisos.`}
      >
        {catalog.isLoading || live.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Bot size={26} />}
            title="Sin agentes"
            description="Ejecuta factory_doctor o sincroniza el catálogo en Models."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="bg-carbon-850">
                <tr>
                  <th className="table-head px-4 py-2.5">Agente</th>
                  <th className="table-head px-4 py-2.5">Rol</th>
                  <th className="table-head px-4 py-2.5">Modo</th>
                  <th className="table-head px-4 py-2.5">Modelo activo</th>
                  <th className="table-head px-4 py-2.5">Modelo del perfil</th>
                  <th className="table-head px-4 py-2.5">Permisos</th>
                  <th className="table-head px-4 py-2.5">Steps</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((agent) => (
                  <tr key={agent.id} className="table-row">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="grid size-6 place-items-center rounded-md border border-line bg-carbon-800 text-[10px] font-semibold text-violet-soft">
                          {agent.id.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <div className="text-xs font-medium text-ink">{agent.id}</div>
                          <div className="text-[10px] text-faint">{agent.name}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-muted">{agent.role}</td>
                    <td className="px-4 py-3">
                      <Badge tone={agent.mode === "primary" ? "violet" : "default"}>{agent.mode}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink">
                        <Cpu size={12} className="text-faint" />
                        {agent.currentModel ?? "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {agent.assignedModel ? (
                        <div className="flex items-center gap-1.5 font-mono text-[11px] text-violet-soft">
                          <Lock size={12} />
                          {agent.assignedModel}
                        </div>
                      ) : (
                        <span className="text-[11px] text-faint">sin asignar</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[11px] text-muted">{agent.permissions}</td>
                    <td className="px-4 py-3 text-[11px] text-muted">
                      {agent.steps ? formatCompact(agent.steps) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Reglas activas" description="Separación entre definición del agente y modelo asignado.">
        <div className="grid gap-3 p-4 md:grid-cols-3">
          <RuleCard
            title="Modelo bloqueado"
            description="Cada agente usa el modelo de su asignación. El orquestador no elige otro en caliente."
          />
          <RuleCard
            title="Sin fallback silencioso"
            description="Si un modelo no está disponible o no soporta tools, la aplicación del perfil falla y lo explica."
          />
          <RuleCard
            title="Cambio auditado"
            description="Aplicar un perfil exige confirmación y queda registrado en factory_audit_events."
          />
        </div>
      </Section>
    </div>
  );
}

function RuleCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-line-soft bg-carbon-950/60 p-3">
      <div className="text-xs font-medium text-ink">{title}</div>
      <p className="mt-1 text-[11px] leading-5 text-muted">{description}</p>
    </div>
  );
}
