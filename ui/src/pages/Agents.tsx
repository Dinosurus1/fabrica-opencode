import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Cpu, Lock, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProject } from "../components/ProjectContext";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Section,
  Spinner,
} from "../components/ui";
import { api } from "../lib/api";
import { cn, formatCompact } from "../lib/format";
import { rpc } from "../lib/rpc";
import type {
  AgentCatalogEntry,
  AgentInfo,
  AgentSelection,
  CatalogAgent,
  Profile,
} from "../lib/types";

interface Signals {
  ambiguous_scope: boolean;
  cross_module: boolean;
  phase_plan: boolean;
  handoff: boolean;
  research: boolean;
  second_opinion: boolean;
}

const SIGNAL_LABELS: Array<{ key: keyof Signals; label: string }> = [
  { key: "phase_plan", label: "Plan por fases" },
  { key: "ambiguous_scope", label: "Alcance ambiguo" },
  { key: "cross_module", label: "Cruza módulos" },
  { key: "handoff", label: "Handoff / documentación" },
  { key: "research", label: "Investigación externa" },
  { key: "second_opinion", label: "Segunda opinión" },
];

export function AgentsPage() {
  const { project, projectId } = useProject();
  const directory = project?.canonical;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<AgentSelection["mode"]>("hybrid");
  const [selected, setSelected] = useState<string[]>([]);
  const [recommended, setRecommended] = useState<string[]>([]);
  const [signals, setSignals] = useState<Signals>({
    ambiguous_scope: false,
    cross_module: false,
    phase_plan: false,
    handoff: false,
    research: false,
    second_opinion: false,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  const selection = useQuery({
    queryKey: ["factory", "agent-selection", directory ?? "default"],
    queryFn: () =>
      rpc<{
        project_id: string;
        selection: AgentSelection;
        catalog: AgentCatalogEntry[];
        recommendation: { recommended: string[]; rationale: Record<string, string> };
      }>("agents.selection.get", {}, directory),
    enabled: Boolean(projectId),
  });
  const activeSession = useQuery({
    queryKey: ["opencode", "active-session"],
    queryFn: async () => {
      const response = await fetch("/api/session/active", { headers: { "x-factory-ui": "1" } });
      if (!response.ok) return null;
      const data = (await response.json()) as { data?: Record<string, unknown> };
      return Object.keys(data.data ?? {})[0] ?? null;
    },
    staleTime: 10_000,
  });
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
  const live = useQuery({
    queryKey: ["opencode", "agents", directory ?? "default"],
    queryFn: () => api.agents(directory),
  });

  useEffect(() => {
    if (!selection.data) return;
    setMode(selection.data.selection.mode);
    setSelected(selection.data.selection.selected);
    setRecommended(
      selection.data.selection.recommended.length > 0
        ? selection.data.selection.recommended
        : selection.data.recommendation.recommended,
    );
  }, [selection.data]);

  const agentCatalog = selection.data?.catalog ?? [];
  const recommendedSet = useMemo(() => new Set(recommended), [recommended]);
  const requiredSet = useMemo(
    () => new Set(agentCatalog.filter((agent) => agent.required).map((agent) => agent.agentId)),
    [agentCatalog],
  );
  const approved = mode === "auto" ? [...new Set([...selected, ...recommended])] : selected;

  const propose = useMutation({
    mutationFn: () =>
      rpc<{ recommended: string[]; rationale: Record<string, string> }>("agents.propose", { ...signals }, directory),
    onSuccess: (result) => {
      setRecommended(result.recommended);
      setNotice(`Recomendación actualizada: ${result.recommended.length} agentes.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const save = useMutation({
    mutationFn: (applySession: boolean) =>
      rpc<{ saved: boolean; selection: AgentSelection; session_applied: boolean }>("agents.selection.set", {
        mode,
        selected,
        recommended,
        confirmed: true,
        apply_session: applySession && Boolean(activeSession.data),
        session_id: activeSession.data ?? undefined,
      }, directory),
    onSuccess: async (result) => {
      setConfirmApply(false);
      setNotice(
        result.saved
          ? result.session_applied
            ? "Selección guardada y aplicada a la sesión activa."
            : "Selección guardada. No hay sesión activa para aplicar permisos."
          : "La selección no se guardó.",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["factory", "agent-selection"] }),
        queryClient.invalidateQueries({ queryKey: ["opencode", "active-session"] }),
      ]);
    },
    onError: (error) => {
      setConfirmApply(false);
      setNotice(error instanceof Error ? error.message : String(error));
    },
  });

  const toggleAgent = (agentId: string) => {
    if (requiredSet.has(agentId) && selected.includes(agentId)) return;
    setSelected((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    );
  };

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
          currentModel: liveAgent?.model
            ? `${liveAgent.model.providerID}/${liveAgent.model.id}`
            : catalogAgent?.modelProvider && catalogAgent?.modelId
              ? `${catalogAgent.modelProvider}/${catalogAgent.modelId}`
              : null,
          assignedModel: assignments.get(id) ?? null,
          permissions: catalogAgent?.permissions?.length ?? liveAgent?.permissions?.length ?? 0,
          steps: liveAgent?.steps ?? catalogAgent?.steps ?? null,
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

  const error = selection.error ?? catalog.error ?? profiles.error ?? profile.error ?? live.error;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agents"
        subtitle="Selección de agentes por proyecto y estado real de los subagentes. La selección se aplica a la sesión como reglas de permiso; el modelo se asigna en Models."
        actions={
          <>
            <Badge tone={activeProfile ? (appliedProfile ? "violet" : "success") : "warning"}>
              <ShieldCheck size={12} /> {activeProfile?.name ?? "sin perfil"}
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

      {notice ? (
        <div className="rounded-lg border border-violet/30 bg-violet/10 px-3 py-2 text-xs text-violet-soft">{notice}</div>
      ) : null}

      {error ? <ErrorState error={error} onRetry={() => void selection.refetch()} /> : null}

      <Section
        title="Selección de agentes"
        description="Manual: solo los elegidos. Híbrido: el core elegido; las recomendaciones se añaden solo si las marcas. Auto: core + recomendaciones."
        actions={
          <Badge tone="violet">
            <Lock size={11} /> {approved.length} aprobados
          </Badge>
        }
      >
        {selection.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-4 p-4">
            <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Modo de selección</label>
                <select
                  className="field"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as AgentSelection["mode"])}
                >
                  <option value="manual">Manual</option>
                  <option value="hybrid">Híbrido</option>
                  <option value="auto">Automático</option>
                </select>
                <p className="mt-2 text-[11px] leading-5 text-faint">
                  {mode === "manual"
                    ? "El usuario fija los agentes; el orquestador no añade ninguno."
                    : mode === "hybrid"
                      ? "El usuario fija el core; las recomendaciones no se añaden hasta que las marques."
                      : "El orquestador puede usar el core más las recomendaciones."}
                </p>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted">Señales para recomendar</div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {SIGNAL_LABELS.map((signal) => (
                    <label key={signal.key} className="flex items-center gap-2 rounded-md border border-line-soft px-2.5 py-1.5 text-[11px] text-muted">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[#7c5cff]"
                        checked={signals[signal.key]}
                        onChange={(event) =>
                          setSignals((current) => ({ ...current, [signal.key]: event.target.checked }))
                        }
                      />
                      {signal.label}
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button variant="ghost" onClick={() => propose.mutate()} disabled={propose.isPending}>
                    <Sparkles size={14} /> Proponer
                  </Button>
                  <span className="text-[11px] text-faint">
                    {recommended.length} recomendados · el modo {mode} decide si se aplican.
                  </span>
                </div>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {agentCatalog.map((agent) => {
                const checked = selected.includes(agent.agentId);
                const isRecommended = recommendedSet.has(agent.agentId);
                const isRequired = requiredSet.has(agent.agentId);
                return (
                  <label
                    key={agent.agentId}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                      checked
                        ? "border-violet/40 bg-violet/10"
                        : "border-line-soft hover:bg-carbon-850",
                      isRequired && checked ? "cursor-default" : undefined,
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 accent-[#7c5cff]"
                      checked={checked}
                      disabled={isRequired && checked}
                      onChange={() => toggleAgent(agent.agentId)}
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-ink">{agent.agentId}</span>
                        {isRequired ? <Badge>requerido</Badge> : null}
                        {isRecommended ? <Badge tone="violet">recomendado</Badge> : null}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-faint">{agent.role}</span>
                      <span className="mt-1 block text-[11px] leading-4 text-muted">{agent.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
              <Button
                onClick={() => save.mutate(false)}
                disabled={save.isPending || selected.length === 0}
              >
                <Check size={14} /> Guardar selección
              </Button>
              <Button
                variant="primary"
                onClick={() => setConfirmApply(true)}
                disabled={save.isPending || selected.length === 0}
              >
                <ShieldCheck size={14} /> Guardar y aplicar a la sesión
              </Button>
              <span className="text-[11px] text-faint">
                {activeSession.data
                  ? `Sesión activa: ${activeSession.data.slice(0, 18)}…`
                  : "No hay sesión activa; se guardará sin aplicar permisos."}
              </span>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Subagentes"
        description={`${rows.length} agentes con modelo o perfil asignado. La selección aprobada controla qué subagentes puede lanzar el orquestador.`}
      >
        {catalog.isLoading || live.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Bot size={26} />} title="Sin agentes" description="Ejecuta factory_doctor o sincroniza el catálogo en Models." />
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
                  <th className="table-head px-4 py-2.5">Reglas</th>
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

      <Section title="Reglas activas" description="Separación entre definición del agente, selección y modelo asignado.">
        <div className="grid gap-3 p-4 md:grid-cols-3">
          <RuleCard title="Modelo bloqueado" description="Cada agente usa el modelo de su asignación. El orquestador no elige otro en caliente." />
          <RuleCard title="Sin fallback silencioso" description="Si un modelo no está disponible o no soporta tools, la aplicación del perfil falla y lo explica." />
          <RuleCard title="Selección aplicada" description="La selección aprobada se traduce en reglas `subagent` de la sesión: los no aprobados quedan denegados." />
        </div>
      </Section>

      <ConfirmDialog
        open={confirmApply}
        title="Aplicar selección a la sesión"
        message={
          <>
            Se guardará la selección <strong className="text-ink">{mode}</strong> con{" "}
            <strong className="text-ink">{approved.length}</strong> agentes aprobados. Los subagentes no incluidos
            quedarán denegados en la sesión activa. ¿Continuar?
          </>
        }
        confirmLabel="Aplicar"
        onConfirm={() => save.mutate(true)}
        onClose={() => setConfirmApply(false)}
      />
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
