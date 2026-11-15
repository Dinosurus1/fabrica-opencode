import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Cpu, Plus, RefreshCw, Save, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProject } from "../components/ProjectContext";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  Section,
  Spinner,
} from "../components/ui";
import { cn, formatCompact, formatUsd } from "../lib/format";
import { analyzePrompt, combinePromptAndProject } from "../lib/profile-detect";
import { api } from "../lib/api";
import { rpc } from "../lib/rpc";
import { messageText } from "../components/sessions/Transcript";
import type {
  CatalogAgent,
  CatalogModel,
  Profile,
  ProfileAssignment,
  ProfileRecommendation,
} from "../lib/types";

interface AssignmentDraft {
  providerId: string;
  modelId: string;
  maxCostUsd: number | null;
  tokenBudget: number | null;
}

interface PolicyDraft {
  allowedProviders: string;
  allowedModels: string;
  prohibitedModels: string;
  requireTools: boolean;
  minContext: number;
  noSilentFallback: boolean;
}


function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildPolicy(base: Record<string, unknown>, draft: PolicyDraft): Record<string, unknown> {
  const policy = { ...base };
  const providers = splitList(draft.allowedProviders);
  const allowed = splitList(draft.allowedModels);
  const prohibited = splitList(draft.prohibitedModels);
  if (providers.length > 0) policy.allowedProviders = providers;
  else delete policy.allowedProviders;
  if (allowed.length > 0) policy.allowedModels = allowed;
  else delete policy.allowedModels;
  if (prohibited.length > 0) policy.prohibitedModels = prohibited;
  else delete policy.prohibitedModels;
  if (draft.requireTools === false) policy.requireTools = false;
  else delete policy.requireTools;
  if (draft.minContext > 0) policy.minContext = Math.round(draft.minContext);
  else delete policy.minContext;
  if (draft.noSilentFallback === false) policy.noSilentFallback = false;
  else delete policy.noSilentFallback;
  return policy;
}

function stable(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function ModelsPage() {
  const { projectId, project } = useProject();
  const directory = project?.canonical;
  const queryClient = useQueryClient();
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [draft, setDraft] = useState<Record<string, AssignmentDraft>>({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<Profile["mode"]>("hybrid");
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>({
    allowedProviders: "",
    allowedModels: "",
    prohibitedModels: "",
    requireTools: true,
    minContext: 0,
    noSilentFallback: true,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [detectSessionId, setDetectSessionId] = useState("");
  const [detectingSession, setDetectingSession] = useState(false);
  const [sessionRecommendation, setSessionRecommendation] = useState<{
    name: string;
    confidence: number;
    reasons: string[];
    profileId: string | null;
  } | null>(null);

  const models = useQuery({
    queryKey: ["factory", "models", directory ?? "default"],
    queryFn: () => rpc<{ count: number; models: CatalogModel[] }>("models.list", { limit: 2000 }, directory),
  });
  const agents = useQuery({
    queryKey: ["factory", "agents", directory ?? "default"],
    queryFn: () => rpc<{ count: number; agents: CatalogAgent[] }>("agents.list", {}, directory),
  });
  const profiles = useQuery({
    queryKey: ["factory", "profiles", directory ?? "default"],
    queryFn: () => rpc<{ count: number; profiles: Profile[]; applied_profile_id?: string | null }>("profiles.list", {}, directory),
  });
  const appliedProfileId = profiles.data?.applied_profile_id ?? null;
  const detectSessions = useQuery({
    queryKey: ["opencode", "sessions", "detect-profile"],
    queryFn: () => api.sessions(120),
    staleTime: 30_000,
  });
  const profile = useQuery({
    queryKey: ["factory", "profile", selectedProfileId, directory ?? "default"],
    queryFn: () => rpc<Profile>("profiles.get", { id: selectedProfileId }, directory),
    enabled: Boolean(selectedProfileId),
  });

  useEffect(() => {
    if (selectedProfileId) return;
    const preferred =
      profiles.data?.profiles.find((item) => item.isDefault) ?? profiles.data?.profiles[0];
    if (preferred) setSelectedProfileId(preferred.id);
  }, [profiles.data, selectedProfileId]);

  useEffect(() => {
    const current = profile.data;
    if (!current) return;
    setName(current.name);
    setDescription(current.description ?? "");
    setMode(current.mode);
    const next: Record<string, AssignmentDraft> = {};
    for (const assignment of current.assignments ?? []) {
      next[assignment.agentId] = {
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        maxCostUsd: assignment.maxCostUsd ?? null,
        tokenBudget: assignment.tokenBudget ?? null,
      };
    }
    setDraft(next);
    const policy = current.policy ?? {};
    setPolicyDraft({
      allowedProviders: Array.isArray(policy.allowedProviders) ? policy.allowedProviders.join(", ") : "",
      allowedModels: Array.isArray(policy.allowedModels) ? policy.allowedModels.join(", ") : "",
      prohibitedModels: Array.isArray(policy.prohibitedModels) ? policy.prohibitedModels.join(", ") : "",
      requireTools: policy.requireTools !== false,
      minContext: typeof policy.minContext === "number" ? policy.minContext : 0,
      noSilentFallback: policy.noSilentFallback !== false,
    });
    setNotice(null);
  }, [profile.data]);

  const modelIndex = useMemo(() => {
    const map = new Map<string, CatalogModel>();
    for (const model of models.data?.models ?? []) {
      map.set(`${model.providerId}/${model.modelId}`, model);
    }
    return map;
  }, [models.data]);

  const modelsByProvider = useMemo(() => {
    const groups = new Map<string, CatalogModel[]>();
    for (const model of models.data?.models ?? []) {
      if (!model.enabled || !model.authorized || model.prohibited) continue;
      if (model.capabilities.tools !== true) continue;
      const list = groups.get(model.providerId) ?? [];
      list.push(model);
      groups.set(model.providerId, list);
    }
    for (const list of groups.values()) {
      list.sort((left, right) => (left.name ?? left.modelId).localeCompare(right.name ?? right.modelId));
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [models.data]);

  const agentRows = useMemo(() => {
    const all = (agents.data?.agents ?? []).filter(
      (agent) => (agent.modelProvider && agent.modelId) || draft[agent.agentId],
    );
    return [...all].sort((left, right) => {
      const leftAssigned = draft[left.agentId] ? 0 : 1;
      const rightAssigned = draft[right.agentId] ? 0 : 1;
      return leftAssigned - rightAssigned || left.agentId.localeCompare(right.agentId);
    });
  }, [agents.data, draft]);

  const effectivePolicy = useMemo(
    () => buildPolicy((profile.data?.policy ?? {}) as Record<string, unknown>, policyDraft),
    [profile.data, policyDraft],
  );

  const dirty = useMemo(() => {
    const current = profile.data;
    if (!current) return false;
    if (name !== current.name || description !== (current.description ?? "") || mode !== current.mode) {
      return true;
    }
    if (stable(current.policy ?? {}) !== stable(effectivePolicy)) return true;
    const currentMap = new Map(
      (current.assignments ?? []).map((assignment) => [
        assignment.agentId,
        `${assignment.providerId}/${assignment.modelId}|${assignment.maxCostUsd ?? ""}|${assignment.tokenBudget ?? ""}`,
      ]),
    );
    const draftEntries = Object.entries(draft);
    if (draftEntries.length !== currentMap.size) return true;
    return draftEntries.some(
      ([agentId, assignment]) =>
        currentMap.get(agentId) !==
        `${assignment.providerId}/${assignment.modelId}|${assignment.maxCostUsd ?? ""}|${assignment.tokenBudget ?? ""}`,
    );
  }, [profile.data, name, description, mode, draft, effectivePolicy]);

  const sync = useMutation({
    mutationFn: () =>
      rpc<{
        synced: { models: number; agents: number };
        seeded_profiles?: { created: string[]; existing: string[]; invalid: unknown[] };
      }>("models.sync", {}, directory),
    onSuccess: async (result) => {
      const created = result.seeded_profiles?.created.length ?? 0;
      setNotice(
        `Catálogo sincronizado: ${result.synced.models} modelos, ${result.synced.agents} agentes.${
          created > 0 ? ` ${created} perfiles predeterminados creados.` : ""
        }`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["factory", "models"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "agents"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "profiles"] }),
      ]);
    },
  });

  const recommend = useMutation({
    mutationFn: () =>
      rpc<ProfileRecommendation>("profiles.recommend", { project_id: projectId, directory }, directory),
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const analyzeSession = async () => {
    if (!detectSessionId) return;
    setDetectingSession(true);
    setSessionRecommendation(null);
    try {
      const messages = await api.sessionContext(detectSessionId);
      const text = messages
        .filter((item) => item.type === "user")
        .slice(-12)
        .map((item) => messageText(item))
        .filter(Boolean)
        .join("\n");
      if (!text.trim()) {
        setNotice("La sesión no tiene mensajes de usuario para analizar.");
        return;
      }
      const combined = combinePromptAndProject(analyzePrompt(text), recommend.data);
      const match = (profiles.data?.profiles ?? []).find(
        (item) => item.name === combined.recommended,
      );
      if (!combined.recommended) {
        setNotice("No hay señales suficientes en la sesión para sugerir un perfil.");
        return;
      }
      setSessionRecommendation({
        name: combined.recommended,
        confidence: combined.confidence,
        reasons: combined.reasons,
        profileId: match?.id ?? null,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setDetectingSession(false);
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!profile.data) throw new Error("No hay perfil seleccionado.");
      const assignments: ProfileAssignment[] = Object.entries(draft).map(([agentId, assignment]) => ({
        agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        locked: true,
        maxCostUsd: assignment.maxCostUsd,
        tokenBudget: assignment.tokenBudget,
      }));
      return rpc<{
        saved: boolean;
        issues?: Array<{ message: string; severity: string }>;
        unapplied?: boolean;
      }>("profiles.upsert", {
        id: profile.data.id,
        name,
        description,
        mode,
        is_default: profile.data.isDefault,
        policy: effectivePolicy,
        assignments,
      }, directory);
    },
    onSuccess: async (result) => {
      if (!result.saved) {
        setNotice(result.issues?.map((issue) => issue.message).join(" · ") ?? "El perfil no es válido.");
        return;
      }
      setNotice(
        result.unapplied
          ? "Perfil guardado. Estaba aplicado, así que vuelve a aplicarlo para que los agentes usen los cambios."
          : "Perfil guardado.",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["factory", "profiles"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "profile", selectedProfileId] }),
      ]);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const apply = useMutation({
    mutationFn: () =>
      rpc<{ applied: boolean; warnings?: string[]; session_updated?: boolean }>("profiles.apply", {
        id: selectedProfileId,
        confirmed: true,
      }, directory),
    onSuccess: async (result) => {
      setConfirmApply(false);
      setNotice(
        result.applied
          ? `Perfil aplicado a los agentes.${result.warnings?.length ? ` Avisos: ${result.warnings.join(" · ")}` : ""}`
          : "El perfil no se aplicó.",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["factory", "agents"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "profile", selectedProfileId] }),
        queryClient.invalidateQueries({ queryKey: ["opencode", "agents"] }),
      ]);
    },
    onError: (error) => {
      setConfirmApply(false);
      setNotice(error instanceof Error ? error.message : String(error));
    },
  });

  const duplicate = useMutation({
    mutationFn: async () => {
      if (!profile.data) throw new Error("No hay perfil seleccionado.");
      const assignments = Object.entries(draft).map(([agentId, assignment]) => ({
        agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        locked: true,
      }));
      return rpc<{ saved: boolean; profile?: Profile }>("profiles.upsert", {
        name: `${profile.data.name} (copia)`,
        description: profile.data.description ?? "",
        mode: profile.data.mode,
        is_default: false,
        policy: profile.data.policy,
        assignments,
      }, directory);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["factory", "profiles"] });
      if (result.profile) {
        setSelectedProfileId(result.profile.id);
        setNotice("Perfil duplicado.");
      }
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const remove = useMutation({
    mutationFn: () => rpc<{ deleted: boolean }>("profiles.delete", { id: selectedProfileId, confirmed: true }, directory),
    onSuccess: async (result) => {
      setConfirmDelete(false);
      if (!result.deleted) {
        setNotice("El perfil no se eliminó.");
        return;
      }
      setSelectedProfileId("");
      setNotice("Perfil eliminado.");
      await queryClient.invalidateQueries({ queryKey: ["factory", "profiles"] });
    },
    onError: (error) => {
      setConfirmDelete(false);
      setNotice(error instanceof Error ? error.message : String(error));
    },
  });

  const filteredModels = useMemo(() => {
    const search = modelSearch.trim().toLowerCase();
    const list = models.data?.models ?? [];
    const providerOrder = (provider: string) =>
      provider === "opencode-go" ? 0 : provider === "opencode" ? 1 : provider === "ollama" ? 3 : 2;
    const filtered = search
      ? list.filter((model) =>
          [model.providerId, model.modelId, model.name, model.family]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(search)),
        )
      : [...list];
    return filtered.sort(
      (left, right) =>
        providerOrder(left.providerId) - providerOrder(right.providerId) ||
        left.providerId.localeCompare(right.providerId) ||
        (left.name ?? left.modelId).localeCompare(right.name ?? right.modelId),
    );
  }, [models.data, modelSearch]);

  const error = models.error ?? agents.error ?? profiles.error ?? profile.error;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Models"
        subtitle="Catálogo real de OpenCode, perfiles de ejecución y asignación de modelo por rol. El modelo se bloquea por agente; no hay sustitución silenciosa."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => recommend.mutate()}
              disabled={recommend.isPending}
              title="Analiza el proyecto y sugiere un perfil sin aplicarlo"
            >
              <Sparkles size={14} className={recommend.isPending ? "animate-pulse" : undefined} />
              Detectar perfil
            </Button>
            <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
              <RefreshCw size={14} className={sync.isPending ? "animate-spin" : undefined} />
              Sincronizar catálogo
            </Button>
            <Button variant="primary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              <Save size={14} /> Guardar perfil
            </Button>
          </>
        }
      />

      {notice ? (
        <div className="rounded-lg border border-violet/30 bg-violet/10 px-3 py-2 text-xs text-violet-soft">
          {notice}
        </div>
      ) : null}

      {error ? <ErrorState error={error} onRetry={() => void models.refetch()} /> : null}

      {recommend.data ? (
        <div className="surface border-violet/30 bg-violet/[0.06] px-4 py-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-violet/30 bg-violet/10 text-violet-soft">
              <Sparkles size={15} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-medium text-ink">
                  Perfil recomendado: {recommend.data.profile?.name ?? recommend.data.recommended}
                </p>
                <Badge tone="violet">
                  {Math.round(recommend.data.confidence * 100)}% confianza
                </Badge>
                <span className="text-[10px] text-faint">
                  {recommend.data.signals?.codeFiles ?? 0} archivos de código ·{" "}
                  {recommend.data.signals?.docFiles ?? 0} documentos
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-5 text-muted">
                {recommend.data.reasons.length > 0
                  ? recommend.data.reasons.join(" · ")
                  : "Sin señales fuertes; se sugiere el perfil más barato."}
              </p>
              {recommend.data.alternatives.length > 0 ? (
                <p className="mt-1 text-[10px] text-faint">
                  Alternativas:{" "}
                  {recommend.data.alternatives
                    .map((item) => `${item.name} (${item.score.toFixed(1)})`)
                    .join(" · ")}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {recommend.data.profile ? (
                <Button
                  className="h-8 px-2.5 text-xs"
                  onClick={() => {
                    setSelectedProfileId(recommend.data!.profile!.id);
                    setNotice(`Perfil seleccionado: ${recommend.data!.profile!.name}. Revísalo y pulsa Aplicar.`);
                  }}
                >
                  Ver perfil
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => recommend.reset()}>
                Cerrar
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="surface px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-ink">Detectar perfil por sesión</p>
            <p className="mt-0.5 text-[11px] leading-5 text-muted">
              Analiza los últimos pedidos de una conversación concreta y combina el resultado con
              las señales del proyecto. No aplica nada; puedes revisarlo antes.
            </p>
          </div>
          <label className="flex min-w-0 items-center gap-2 text-[10px] text-faint">
            <span className="shrink-0">Sesión</span>
            <select
              className="h-8 max-w-[260px] rounded-md border border-line bg-carbon-900 px-2 text-[11px] text-ink outline-none focus:border-violet"
              value={detectSessionId}
              onChange={(event) => {
                setDetectSessionId(event.target.value);
                setSessionRecommendation(null);
              }}
            >
              <option value="">Elige una sesión</option>
              {(detectSessions.data ?? [])
                .filter((session) => !session.parentID && !session.location?.directory?.startsWith("/tmp/"))
                .map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title ?? session.id}
                  </option>
                ))}
            </select>
          </label>
          <Button
            className="h-8 px-2.5 text-xs"
            onClick={() => void analyzeSession()}
            disabled={!detectSessionId || detectingSession}
          >
            <Sparkles size={13} className={detectingSession ? "animate-pulse" : undefined} />
            {detectingSession ? "Analizando…" : "Analizar sesión"}
          </Button>
        </div>
        {sessionRecommendation ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-violet/25 bg-violet/[0.06] px-3 py-2 text-[11px]">
            <Badge tone="violet">
              {Math.round(sessionRecommendation.confidence * 100)} % confianza
            </Badge>
            <span className="font-medium text-ink">
              Perfil sugerido por la sesión: {sessionRecommendation.name}
            </span>
            <span className="min-w-0 flex-1 text-muted">
              {sessionRecommendation.reasons.slice(0, 2).join(" · ")}
            </span>
            {sessionRecommendation.profileId ? (
              <Button
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setSelectedProfileId(sessionRecommendation.profileId!);
                  setNotice(
                    `Perfil seleccionado: ${sessionRecommendation.name}. Revísalo y pulsa Aplicar.`,
                  );
                }}
              >
                Ver perfil
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <Section
          title="Perfiles"
          description={`${profiles.data?.count ?? 0} guardados`}
          actions={
            <Button
              variant="ghost"
              onClick={() => duplicate.mutate()}
              disabled={!profile.data || duplicate.isPending}
              title="Duplicar perfil"
            >
              <Copy size={14} />
            </Button>
          }
        >
          <div className="p-2">
            {profiles.isLoading ? (
              <div className="p-4">
                <Spinner />
              </div>
            ) : (profiles.data?.profiles.length ?? 0) === 0 ? (
              <EmptyState
                title="Sin perfiles"
                description="Sincroniza el catálogo para crear el perfil Actual."
                action={
                  <Button onClick={() => sync.mutate()}>
                    <Plus size={14} /> Crear desde OpenCode
                  </Button>
                }
              />
            ) : (
              <div className="space-y-1">
                {profiles.data?.profiles.map((item) => (
                  <button
                    key={item.id}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                      selectedProfileId === item.id
                        ? "border-violet/40 bg-violet/10"
                        : "border-transparent hover:bg-carbon-800",
                    )}
                    onClick={() => setSelectedProfileId(item.id)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-ink">{item.name}</span>
                      {item.isDefault ? <Badge tone="success">default</Badge> : null}
                      {item.id === appliedProfileId ? <Badge tone="violet">aplicado</Badge> : null}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-faint">
                      <span className="uppercase tracking-[0.08em]">{item.mode}</span>
                      <span>·</span>
                      <span>{item.id === appliedProfileId ? "en uso" : item.isDefault ? "default" : "guardado"}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Section>

        <div className="min-w-0 space-y-5">
          <Section
            className="min-w-0"
            title={profile.data ? `Editar: ${profile.data.name}` : "Perfil"}
            description="El perfil define qué modelo ejecuta cada agente. No cambia permisos ni instrucciones."
            actions={
              profile.data ? (
                <>
                  <Button
                    variant="danger"
                    onClick={() => setConfirmDelete(true)}
                    disabled={remove.isPending}
                  >
                    <Trash2 size={14} /> Eliminar
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => setConfirmApply(true)}
                    disabled={dirty || apply.isPending || profile.data?.applied === true}
                    title={
                    dirty
                      ? "Guarda el perfil antes de aplicarlo"
                      : profile.data?.applied
                        ? "Este perfil ya está aplicado"
                        : "Aplicar a los agentes"
                  }
                  >
                    <Wand2 size={14} /> Aplicar
                  </Button>
                </>
              ) : null
            }
          >
            {profile.isLoading ? (
              <div className="p-6">
                <Spinner />
              </div>
            ) : !profile.data ? (
              <EmptyState
                title="Selecciona un perfil"
                description="Elige un perfil de la izquierda o sincroniza el catálogo para crear el perfil Actual."
              />
            ) : (
              <div className="space-y-4 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Nombre">
                    <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
                  </Field>
                  <Field label="Modo de modelo" hint="Manual fija el modelo por rol; auto elige en código; híbrido pide aprobación en tareas sensibles.">
                    <select
                      className="field"
                      value={mode}
                      onChange={(event) => setMode(event.target.value as Profile["mode"])}
                    >
                      <option value="hybrid">Híbrido (auto con aprobación)</option>
                      <option value="auto">Automático (código + historial)</option>
                      <option value="manual">Manual (modelo fijado por rol)</option>
                    </select>
                  </Field>
                </div>
                <Field label="Descripción">
                  <input
                    className="field"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Qué busca este perfil: coste, calidad, velocidad..."
                  />
                </Field>

                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full border-collapse text-left">
                    <thead className="bg-carbon-850">
                      <tr>
                        <th className="table-head px-3 py-2">Agente</th>
                        <th className="table-head px-3 py-2">Rol</th>
                        <th className="table-head px-3 py-2">Modelo asignado</th>
                        <th className="table-head px-3 py-2">Contexto</th>
                        <th className="table-head px-3 py-2">Token budget</th>
                        <th className="table-head px-3 py-2">Coste máx.</th>
                        <th className="table-head px-3 py-2">Tools</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agentRows.map((agent) => {
                        const assignment = draft[agent.agentId];
                        const selected = assignment
                          ? modelIndex.get(`${assignment.providerId}/${assignment.modelId}`)
                          : null;
                        return (
                          <tr key={agent.agentId} className="table-row">
                            <td className="px-3 py-2">
                              <div className="text-xs font-medium text-ink">{agent.agentId}</div>
                              <div className="text-[10px] text-faint">{agent.mode ?? "—"}</div>
                            </td>
                            <td className="px-3 py-2 text-[11px] text-muted">{agent.role ?? "—"}</td>
                            <td className="px-3 py-2">
                              <select
                                className="field h-8 min-w-[220px] text-xs"
                                value={assignment ? `${assignment.providerId}/${assignment.modelId}` : ""}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  if (!value) {
                                    setDraft((current) => {
                                      const next = { ...current };
                                      delete next[agent.agentId];
                                      return next;
                                    });
                                    return;
                                  }
                                  const slash = value.indexOf("/");
                                  const providerId = value.slice(0, slash);
                                  const modelId = value.slice(slash + 1);
                                  setDraft((current) => ({
                                    ...current,
                                    [agent.agentId]: {
                                      providerId,
                                      modelId,
                                      maxCostUsd: current[agent.agentId]?.maxCostUsd ?? null,
                                      tokenBudget: current[agent.agentId]?.tokenBudget ?? null,
                                    },
                                  }));
                                }}
                              >
                                <option value="">Sin asignar</option>
                                {modelsByProvider.map(([provider, list]) => (
                                  <optgroup key={provider} label={provider}>
                                    {list.map((model) => (
                                      <option key={`${provider}/${model.modelId}`} value={`${provider}/${model.modelId}`}>
                                        {model.name ?? model.modelId}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2 text-[11px] text-muted">
                              {selected?.contextLimit ? formatCompact(selected.contextLimit) : "—"}
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                min={0}
                                step={1000}
                                className="field h-8 w-24 text-xs"
                                value={assignment?.tokenBudget ?? ""}
                                placeholder="ponderado"
                                disabled={!assignment}
                                onChange={(event) => {
                                  if (!assignment) return;
                                  const value = event.target.value === "" ? null : Math.max(0, Math.round(Number(event.target.value)));
                                  setDraft((current) => ({
                                    ...current,
                                    [agent.agentId]: { ...current[agent.agentId]!, tokenBudget: value },
                                  }));
                                }}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                className="field h-8 w-24 text-xs"
                                value={assignment?.maxCostUsd ?? ""}
                                placeholder="—"
                                disabled={!assignment}
                                onChange={(event) => {
                                  if (!assignment) return;
                                  const value = event.target.value === "" ? null : Math.max(0, Number(event.target.value));
                                  setDraft((current) => ({
                                    ...current,
                                    [agent.agentId]: { ...current[agent.agentId]!, maxCostUsd: value },
                                  }));
                                }}
                              />
                            </td>
                            <td className="px-3 py-2">
                              {selected ? (
                                <Badge tone={selected.capabilities.tools ? "success" : "danger"}>
                                  {selected.capabilities.tools ? "tools" : "sin tools"}
                                </Badge>
                              ) : (
                                <span className="text-[11px] text-faint">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <details className="rounded-lg border border-line-soft bg-carbon-950/40 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-ink">Política de modelos</summary>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <Field label="Proveedores permitidos" hint="Separados por comas; vacío = todos.">
                      <input
                        className="field"
                        value={policyDraft.allowedProviders}
                        onChange={(event) => setPolicyDraft({ ...policyDraft, allowedProviders: event.target.value })}
                        placeholder="opencode-go, opencode"
                      />
                    </Field>
                    <Field label="Modelos permitidos" hint="provider/modelo separados por comas; vacío = todos.">
                      <input
                        className="field"
                        value={policyDraft.allowedModels}
                        onChange={(event) => setPolicyDraft({ ...policyDraft, allowedModels: event.target.value })}
                        placeholder="opencode-go/glm-5.3-flash"
                      />
                    </Field>
                    <Field label="Modelos prohibidos" hint="provider/modelo separados por comas.">
                      <input
                        className="field"
                        value={policyDraft.prohibitedModels}
                        onChange={(event) => setPolicyDraft({ ...policyDraft, prohibitedModels: event.target.value })}
                        placeholder="opencode-go/gpt-5.5-pro"
                      />
                    </Field>
                    <Field label="Contexto mínimo" hint="Tokens mínimos de ventana; 0 = sin mínimo.">
                      <input
                        type="number"
                        min={0}
                        step={1000}
                        className="field"
                        value={policyDraft.minContext}
                        onChange={(event) => setPolicyDraft({ ...policyDraft, minContext: Math.max(0, Number(event.target.value)) })}
                      />
                    </Field>
                    <label className="flex items-end gap-2 pb-2 text-xs text-muted">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[#7c5cff]"
                        checked={policyDraft.requireTools}
                        onChange={(event) => setPolicyDraft({ ...policyDraft, requireTools: event.target.checked })}
                      />
                      Exigir soporte de tools
                    </label>
                    <div className="rounded-md border border-line-soft px-2.5 py-2 text-[11px] leading-5 text-faint">
                      Sin sustituciones silenciosas: si el modelo no cumple la política, el lanzamiento falla.
                    </div>
                  </div>
                </details>
              </div>
            )}
          </Section>

          <Section
            className="min-w-0"
            title="Catálogo"
            description="Modelos visibles en OpenCode con coste de catálogo, contexto y capacidades."
            actions={
              <input
                className="field h-8 w-56 text-xs"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="Filtrar modelos..."
              />
            }
          >
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full border-collapse text-left">
                <thead className="sticky top-0 z-10 bg-carbon-850">
                  <tr>
                    <th className="table-head px-3 py-2">Modelo</th>
                    <th className="table-head px-3 py-2">Provider</th>
                    <th className="table-head px-3 py-2">Contexto</th>
                    <th className="table-head px-3 py-2">Coste in/out</th>
                    <th className="table-head px-3 py-2">Tools</th>
                    <th className="table-head px-3 py-2">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModels.map((model) => (
                    <tr key={`${model.providerId}/${model.modelId}`} className="table-row">
                      <td className="px-3 py-2">
                        <div className="text-xs font-medium text-ink">{model.name ?? model.modelId}</div>
                        <div className="font-mono text-[10px] text-faint">{model.modelId}</div>
                      </td>
                      <td className="px-3 py-2 text-[11px] text-muted">{model.providerId}</td>
                      <td className="px-3 py-2 text-[11px] text-muted">
                        {model.contextLimit ? formatCompact(model.contextLimit) : "—"}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-muted">
                        {formatUsd(model.costInput)} / {formatUsd(model.costOutput)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={model.capabilities.tools ? "success" : "danger"}>
                          {model.capabilities.tools ? "sí" : "no"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={model.status === "active" ? "success" : "warning"}>{model.status}</Badge>
                          {model.prohibited ? <Badge tone="danger">prohibido</Badge> : null}
                          {!model.authorized ? <Badge tone="warning">no autorizado</Badge> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredModels.length === 0 ? (
                <EmptyState
                  icon={<Cpu size={24} />}
                  title="Sin modelos"
                  description="Sincroniza el catálogo o cambia el filtro."
                />
              ) : null}
            </div>
          </Section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmApply}
        title="Aplicar perfil"
        message={
          <>
            Se cambiará el modelo de <strong className="text-ink">{profile.data?.assignments?.length ?? 0}</strong>{" "}
            agentes. No se modifican permisos, prompts ni skills. ¿Continuar?
          </>
        }
        confirmLabel="Aplicar modelo"
        onConfirm={() => apply.mutate()}
        onClose={() => setConfirmApply(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Eliminar perfil"
        message={
          <>
            Se eliminará el perfil <strong className="text-ink">{profile.data?.name}</strong>. Los agentes
            conservan su modelo actual hasta que apliques otro perfil. ¿Continuar?
          </>
        }
        confirmLabel="Eliminar"
        danger
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
