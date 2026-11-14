import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Brain, GitMerge, Pencil, Pin, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useProject } from "../components/ProjectContext";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  Section,
  Spinner,
  StatCard,
} from "../components/ui";
import { formatDate, formatNumber, relativeTime } from "../lib/format";
import { rpc } from "../lib/rpc";
import type { MemoryItem, MemoryStats } from "../lib/types";

interface MemoryUpdate {
  title: string;
  tags: string;
  importance: number;
  pinned: boolean;
}

interface MemoryCluster {
  entity_key: string;
  action: "merge" | "keep_separate" | "archive";
  source_ids: string[];
  merged_content: string;
  dropped_facts: Array<{ fact: string; reason: string }>;
  conflicts: Array<{ old: string; new: string; resolution: string }>;
  confidence: number;
}

interface MemoryPlan {
  clusters: MemoryCluster[];
}

interface MemoryBackup {
  id: string;
  path: string;
  count: number;
  created_at: string;
}

interface MemoryVerification {
  query: string;
  matches: Array<{ id: string; entity_key: string | null; title: string | null; updated_at: string }>;
}

interface MemoryApplyResult {
  applied: boolean;
  requires_confirmation?: boolean;
  requires_approval?: boolean;
  reason?: string;
  backup?: MemoryBackup;
  merged?: number;
  archived?: number;
  kept?: number;
  errors?: string[];
  execution_id?: string;
  verification?: MemoryVerification[];
}

function parseQueries(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].slice(0, 10);
}

function defaultQueries(plan: MemoryPlan, items: MemoryItem[], search: string): string {
  const values = [
    ...plan.clusters.map((cluster) => cluster.entity_key),
    ...items.slice(0, 8).map((memory) => memory.title ?? memory.content.slice(0, 60)),
    search,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(values)].slice(0, 10).join("\n");
}

export function MemoryPage() {
  const { project } = useProject();
  const directory = project?.canonical;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("");
  const [kind, setKind] = useState("");
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [form, setForm] = useState<MemoryUpdate>({ title: "", tags: "", importance: 3, pinned: false });
  const [deleting, setDeleting] = useState<MemoryItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [planSearch, setPlanSearch] = useState("");
  const [plan, setPlan] = useState<MemoryPlan | null>(null);
  const [backup, setBackup] = useState<MemoryBackup | null>(null);
  const [applyResult, setApplyResult] = useState<MemoryApplyResult | null>(null);
  const [verification, setVerification] = useState<MemoryVerification[] | null>(null);
  const [approveRisky, setApproveRisky] = useState(false);
  const [verificationQueries, setVerificationQueries] = useState("");
  const [consolidationError, setConsolidationError] = useState<string | null>(null);

  const stats = useQuery({
    queryKey: ["factory", "memory-stats", directory ?? "default"],
    queryFn: () => rpc<MemoryStats>("memory.stats", {}, directory),
  });
  const memories = useQuery({
    queryKey: ["factory", "memories", search, scope, kind, pinned, directory ?? "default"],
    queryFn: () =>
      rpc<{ count: number; memories: MemoryItem[] }>("memory.list", {
        search: search || undefined,
        scope: scope || undefined,
        kind: kind || undefined,
        pinned: pinned || undefined,
        limit: 200,
      }, directory),
  });

  const update = useMutation({
    mutationFn: () =>
      rpc("memory.update", {
        id: editing!.id,
        title: form.title.trim() || null,
        tags: form.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        importance: form.importance,
        pinned: form.pinned,
      }, directory),
    onSuccess: async () => {
      setEditing(null);
      setNotice("Memoria actualizada.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["factory", "memories"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "memory-stats"] }),
      ]);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const remove = useMutation({
    mutationFn: () => rpc<{ deleted: number }>("memory.delete", { ids: [deleting!.id], confirmed: true }, directory),
    onSuccess: async (result) => {
      setDeleting(null);
      setNotice(`Memoria eliminada (${result.deleted}).`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["factory", "memories"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "memory-stats"] }),
      ]);
    },
    onError: (error) => {
      setDeleting(null);
      setNotice(error instanceof Error ? error.message : String(error));
    },
  });

  const planMutation = useMutation({
    mutationFn: async () => {
      setConsolidationError(null);
      setApplyResult(null);
      setVerification(null);
      setApproveRisky(false);
      const created = await rpc<MemoryBackup>("memory.backup", { label: "consolidación desde la consola" }, directory);
      setBackup(created);
      const generated = await rpc<MemoryPlan>("memory.consolidation.plan", {
        search: planSearch.trim() || undefined,
        limit: 200,
      }, directory);
      setPlan(generated);
      setVerificationQueries(defaultQueries(generated, memories.data?.memories ?? [], planSearch));
      return generated;
    },
    onError: (error) => setConsolidationError(error instanceof Error ? error.message : String(error)),
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error("Genera un plan antes de aplicar.");
      const queries = parseQueries(verificationQueries);
      if (queries.length < 5) throw new Error("Incluye al menos 5 consultas de verificación.");
      setConsolidationError(null);
      const result = await rpc<MemoryApplyResult>("memory.consolidation.apply", {
        plan,
        confirmed: true,
        approve_low_confidence: approveRisky,
        verification_queries: queries,
      }, directory);
      setApplyResult(result);
      if (result.verification) setVerification(result.verification);
      if (result.requires_approval) {
        setConsolidationError("El plan tiene conflictos o confianza baja: marca la aprobación explícita.");
      }
      return result;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["factory", "memories"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "memory-stats"] }),
      ]);
    },
    onError: (error) => setConsolidationError(error instanceof Error ? error.message : String(error)),
  });

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const queries = parseQueries(verificationQueries);
      if (queries.length < 5) throw new Error("Incluye al menos 5 consultas de verificación.");
      setConsolidationError(null);
      const result = await rpc<{ count: number; verification: MemoryVerification[] }>(
        "memory.consolidation.verify",
        { queries },
        directory,
      );
      setVerification(result.verification);
      return result;
    },
    onError: (error) => setConsolidationError(error instanceof Error ? error.message : String(error)),
  });

  const items = memories.data?.memories ?? [];
  const byScope = stats.data?.byScope ?? {};
  const byKind = stats.data?.byKind ?? {};
  const risky = useMemo(
    () => (plan?.clusters ?? []).some((cluster) => cluster.confidence < 0.7 || cluster.conflicts.length > 0),
    [plan],
  );
  const queryCount = parseQueries(verificationQueries).length;

  const openConsolidation = () => {
    setConsolidating(true);
    setPlan(null);
    setBackup(null);
    setApplyResult(null);
    setVerification(null);
    setConsolidationError(null);
    setApproveRisky(false);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Memory"
        subtitle="Memoria vectorial compartida. Aquí puedes auditar, buscar textualmente, editar metadatos y consolidar duplicados con backup y aprobación. La búsqueda semántica sigue en el chat con memory_search."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="default" className="h-8 px-3 text-xs" onClick={openConsolidation}>
              <GitMerge size={13} /> Consolidar
            </Button>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                className="field h-8 w-64 pl-8 text-xs"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar en contenido y título..."
              />
            </div>
            <select className="field h-8 w-28 text-xs" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="">Todo scope</option>
              <option value="global">Global</option>
              <option value="project">Proyecto</option>
            </select>
            <select className="field h-8 w-32 text-xs" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">Todo tipo</option>
              {["preference", "fact", "decision", "convention", "snippet"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                className="size-3.5 accent-[#7c5cff]"
                checked={pinned}
                onChange={(event) => setPinned(event.target.checked)}
              />
              Fijadas
            </label>
          </div>
        }
      />

      {notice ? (
        <div className="rounded-lg border border-violet/30 bg-violet/10 px-3 py-2 text-xs text-violet-soft">{notice}</div>
      ) : null}

      {stats.error ? <ErrorState error={stats.error} onRetry={() => void stats.refetch()} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Memorias" value={formatNumber(stats.data?.total ?? 0)} hint="global + proyecto" icon={<Brain size={15} />} />
        <StatCard label="Globales" value={formatNumber(byScope.global ?? 0)} hint="preferencias y entorno" tone="violet" />
        <StatCard label="De proyecto" value={formatNumber(byScope.project ?? 0)} hint="decisiones y convenciones" tone="success" />
        <StatCard label="Tamaño" value={stats.data?.size ?? "—"} hint={`${Object.keys(byKind).length} tipos`} />
      </div>

      <Section
        title="Memorias"
        description={`${items.length} resultados${memories.isFetching ? " · actualizando" : ""}`}
      >
        {memories.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : memories.isError ? (
          <ErrorState error={memories.error} onRetry={() => void memories.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Brain size={26} />}
            title="Sin memorias"
            description="La memoria se llena con memory_upsert o con la captura automática de sesiones."
          />
        ) : (
          <div className="max-h-[70vh] divide-y divide-line-soft overflow-y-auto">
            {items.map((memory) => (
              <article key={memory.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={memory.scope === "global" ? "violet" : "default"}>{memory.scope}</Badge>
                  <Badge>{memory.kind}</Badge>
                  {memory.entityKey ? <Badge tone="success">{memory.entityKey}</Badge> : null}
                  {memory.pinned ? (
                    <Badge tone="warning">
                      <Pin size={11} /> fijada
                    </Badge>
                  ) : null}
                  <span className="text-[10px] text-faint">importancia {memory.importance}/5</span>
                  <span className="ml-auto text-[10px] text-faint">{relativeTime(memory.updatedAt)}</span>
                </div>
                {memory.title ? <h3 className="mt-2 text-xs font-semibold text-ink">{memory.title}</h3> : null}
                <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted">{memory.content}</p>
                {memory.tags.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {memory.tags.map((tag) => (
                      <span key={tag} className="rounded border border-line bg-carbon-800 px-1.5 py-0.5 text-[10px] text-faint">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-mono text-[10px] text-faint">{memory.id.slice(0, 12)}…</span>
                  <span className="text-[10px] text-faint">{formatDate(memory.createdAt)}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => {
                        setEditing(memory);
                        setForm({
                          title: memory.title ?? "",
                          tags: memory.tags.join(", "),
                          importance: memory.importance,
                          pinned: memory.pinned,
                        });
                      }}
                    >
                      <Pencil size={12} /> Editar
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-[11px] text-danger hover:text-danger"
                      onClick={() => setDeleting(memory)}
                    >
                      <Trash2 size={12} /> Borrar
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </Section>

      <Modal
        open={Boolean(editing)}
        title="Editar memoria"
        description="Cambiar metadatos no regenera el embedding; el contenido se mantiene."
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={() => update.mutate()} disabled={update.isPending}>
              Guardar
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Título">
            <input className="field" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </Field>
          <Field label="Tags" hint="Separadas por comas.">
            <input className="field" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Importancia">
              <select
                className="field"
                value={form.importance}
                onChange={(event) => setForm({ ...form, importance: Number(event.target.value) })}
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    {value} / 5
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-end gap-2 pb-2 text-xs text-muted">
              <input
                type="checkbox"
                className="size-3.5 accent-[#7c5cff]"
                checked={form.pinned}
                onChange={(event) => setForm({ ...form, pinned: event.target.checked })}
              />
              Fijar en el contexto
            </label>
          </div>
        </div>
      </Modal>

      <Modal
        open={consolidating}
        title="Consolidar memoria"
        description="Dry-run primero. Se crea un backup, se agrupan memorias por entidad y nada se aplica hasta que lo confirmes. Los originales se archivan con soft delete."
        onClose={() => setConsolidating(false)}
        width="max-w-4xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConsolidating(false)}>
              Cerrar
            </Button>
            <Button
              variant="default"
              onClick={() => planMutation.mutate()}
              disabled={planMutation.isPending || applyMutation.isPending}
            >
              {planMutation.isPending ? "Generando..." : plan ? "Regenerar plan" : "Crear backup y plan"}
            </Button>
            <Button
              variant="primary"
              onClick={() => applyMutation.mutate()}
              disabled={
                !plan ||
                plan.clusters.length === 0 ||
                applyMutation.isPending ||
                applyResult?.applied ||
                (risky && !approveRisky) ||
                queryCount < 5
              }
            >
              {applyMutation.isPending ? "Aplicando..." : applyResult?.applied ? "Aplicado" : "Aplicar consolidación"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-carbon-800/60 px-3 py-2 text-[11px] leading-5 text-muted">
            <strong className="text-ink">Flujo seguro:</strong> backup → plan dry-run → aprobación si hay
            conflictos o confianza baja → soft delete con enlace al documento consolidado → execution log →
            verificación con 5-10 consultas reales.
          </div>

          <Field label="Filtro del plan" hint="Opcional. Si lo dejas vacío se analizan hasta 200 memorias recientes.">
            <input
              className="field"
              value={planSearch}
              onChange={(event) => setPlanSearch(event.target.value)}
              placeholder="proyecto, tema o texto..."
            />
          </Field>

          {backup ? (
            <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[11px] text-success">
              <ShieldCheck size={13} className="mr-1 inline" /> Backup {backup.id.slice(0, 12)}… · {backup.count} memorias ·{" "}
              <span className="font-mono">{backup.path}</span>
            </div>
          ) : null}

          {consolidationError ? (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
              {consolidationError}
            </div>
          ) : null}

          {planMutation.isPending ? (
            <div className="p-6">
              <Spinner label="Generando plan dry-run" />
            </div>
          ) : null}

          {plan ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <Badge>{plan.clusters.length} clusters</Badge>
                <Badge tone="violet">{plan.clusters.filter((cluster) => cluster.action === "merge").length} fusiones</Badge>
                <Badge tone="warning">{plan.clusters.filter((cluster) => cluster.conflicts.length > 0).length} con conflictos</Badge>
                {risky ? (
                  <span className="inline-flex items-center gap-1 text-warning">
                    <AlertTriangle size={12} /> Requiere aprobación explícita
                  </span>
                ) : null}
              </div>

              <div className="max-h-[34vh] space-y-2 overflow-y-auto pr-1">
                {plan.clusters.map((cluster, index) => (
                  <article key={`${cluster.entity_key}-${index}`} className="rounded-lg border border-line bg-carbon-900/60 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-ink">{cluster.entity_key}</span>
                      <Badge tone={cluster.action === "merge" ? "success" : cluster.action === "archive" ? "warning" : "default"}>
                        {cluster.action}
                      </Badge>
                      <Badge tone={cluster.confidence < 0.7 ? "warning" : "default"}>
                        confianza {Math.round(cluster.confidence * 100)}%
                      </Badge>
                      <span className="ml-auto text-[10px] text-faint">{cluster.source_ids.length} memorias</span>
                    </div>
                    {cluster.conflicts.length > 0 ? (
                      <ul className="mt-2 space-y-1 rounded border border-warning/30 bg-warning/5 px-2 py-1.5 text-[10px] text-warning">
                        {cluster.conflicts.map((conflict, conflictIndex) => (
                          <li key={conflictIndex}>
                            <strong>Conflicto:</strong> {conflict.old} → {conflict.new} ({conflict.resolution})
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {cluster.dropped_facts.length > 0 ? (
                      <p className="mt-2 text-[10px] text-faint">
                        Descarta: {cluster.dropped_facts.map((item) => `${item.fact} (${item.reason})`).join(" · ")}
                      </p>
                    ) : null}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[10px] text-violet-soft">Ver documento consolidado</summary>
                      <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[10px] leading-4 text-muted">
                        {cluster.merged_content || "(sin contenido)"}
                      </pre>
                    </details>
                  </article>
                ))}
              </div>

              {risky ? (
                <label className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 accent-[#eab308]"
                    checked={approveRisky}
                    onChange={(event) => setApproveRisky(event.target.checked)}
                  />
                  Apruebo los clusters con conflictos o confianza baja. Revisé el documento consolidado y asumo la
                  decisión.
                </label>
              ) : null}

              <Field
                label={`Consultas de verificación (${queryCount}/10)`}
                hint="Una por línea. Mínimo 5. Deben ser búsquedas reales que comprueben que la información sigue apareciendo."
              >
                <textarea
                  className="field min-h-24 font-mono text-[11px]"
                  value={verificationQueries}
                  onChange={(event) => setVerificationQueries(event.target.value)}
                />
              </Field>

              <div className="flex items-center gap-2">
                <Button
                  variant="default"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => verifyMutation.mutate()}
                  disabled={verifyMutation.isPending || queryCount < 5}
                >
                  {verifyMutation.isPending ? "Verificando..." : "Verificar ahora"}
                </Button>
                <span className="text-[10px] text-faint">
                  La verificación se ejecuta también al aplicar y queda en el execution log.
                </span>
              </div>

              {applyResult ? (
                <div
                  className={`rounded-lg border px-3 py-2 text-[11px] ${
                    applyResult.applied
                      ? "border-success/30 bg-success/10 text-success"
                      : "border-warning/30 bg-warning/10 text-warning"
                  }`}
                >
                  {applyResult.applied ? (
                    <>
                      <strong>Aplicado.</strong> {applyResult.merged ?? 0} fusiones, {applyResult.archived ?? 0} archivadas,{" "}
                      {applyResult.kept ?? 0} intactas. Execution log:{" "}
                      <span className="font-mono">{applyResult.execution_id?.slice(0, 12) ?? "—"}…</span>
                      {applyResult.errors && applyResult.errors.length > 0 ? (
                        <ul className="mt-1 list-disc pl-4 text-[10px]">
                          {applyResult.errors.map((error, errorIndex) => (
                            <li key={errorIndex}>{error}</li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : (
                    <>{applyResult.reason ?? "La consolidación no se aplicó."}</>
                  )}
                </div>
              ) : null}

              {verification ? (
                <div className="rounded-lg border border-line bg-carbon-900/60 px-3 py-2">
                  <p className="mb-1 text-[11px] font-semibold text-ink">Verificación</p>
                  <ul className="space-y-1">
                    {verification.map((entry, entryIndex) => (
                      <li key={`${entry.query}-${entryIndex}`} className="flex flex-wrap items-center gap-2 text-[10px]">
                        <span className="font-mono text-muted">{entry.query}</span>
                        <Badge tone={entry.matches.length > 0 ? "success" : "warning"}>
                          {entry.matches.length} coincidencias
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Borrar memoria"
        message={
          <>
            Se eliminará la memoria <strong className="text-ink">{deleting?.title ?? deleting?.id}</strong> de forma
            permanente. ¿Continuar?
          </>
        }
        confirmLabel="Borrar"
        danger
        onConfirm={() => remove.mutate()}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
