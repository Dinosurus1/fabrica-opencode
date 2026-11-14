import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ListChecks, RefreshCw, ShieldAlert, Wallet, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useProject } from "../components/ProjectContext";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  ProgressBar,
  Section,
  Spinner,
  StatCard,
  Tabs,
} from "../components/ui";
import { cn, formatCompact, formatDate, formatUsd, percent, statusClass } from "../lib/format";
import { rpc } from "../lib/rpc";
import type { BudgetRecord, ExecutionRecord, WorkGate, WorkOverview, WorkPlan, WorkReview, WorkTask } from "../lib/types";

type WorkTab = "tasks" | "plans" | "gates" | "reviews" | "runs";

export function WorkPage() {
  const { projectId, project } = useProject();
  const directory = project?.canonical;
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<WorkTab>("tasks");
  const [planId, setPlanId] = useState<string | null>(null);
  const [budgetTokens, setBudgetTokens] = useState<number | "">("");
  const [budgetCost, setBudgetCost] = useState<number | "">("");
  const [budgetNotice, setBudgetNotice] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ["factory", "work-overview", projectId],
    queryFn: () => rpc<WorkOverview>("work.overview", { project_id: projectId }, directory),
    enabled: Boolean(projectId),
  });
  const tasks = useQuery({
    queryKey: ["factory", "work-tasks", projectId],
    queryFn: () => rpc<{ count: number; tasks: WorkTask[] }>("work.tasks", { project_id: projectId, limit: 100 }, directory),
    enabled: Boolean(projectId),
  });
  const plans = useQuery({
    queryKey: ["factory", "work-plans", projectId],
    queryFn: () => rpc<{ count: number; plans: WorkPlan[] }>("work.plans", { project_id: projectId, limit: 50 }, directory),
    enabled: Boolean(projectId),
  });
  const gates = useQuery({
    queryKey: ["factory", "work-gates", projectId],
    queryFn: () => rpc<{ count: number; gates: WorkGate[] }>("work.gates", { project_id: projectId, limit: 100 }, directory),
    enabled: Boolean(projectId),
  });
  const reviews = useQuery({
    queryKey: ["factory", "work-reviews", projectId],
    queryFn: () => rpc<{ count: number; reviews: WorkReview[] }>("work.reviews", { project_id: projectId, limit: 100 }, directory),
    enabled: Boolean(projectId),
  });
  const plan = useQuery({
    queryKey: ["factory", "work-plan", planId],
    queryFn: () => rpc<Record<string, unknown>>("work.plan", { project_id: projectId, plan_id: planId }, directory),
    enabled: Boolean(planId),
  });
  const executions = useQuery({
    queryKey: ["factory", "executions", projectId],
    queryFn: () =>
      rpc<{ count: number; executions: ExecutionRecord[] }>(
        "executions.list",
        { project_id: projectId, limit: 150 },
        directory,
      ),
    enabled: Boolean(projectId),
  });
  const budgets = useQuery({
    queryKey: ["factory", "budgets", projectId],
    queryFn: () =>
      rpc<{ count: number; budgets: BudgetRecord[] }>("budgets.list", { project_id: projectId }, directory),
    enabled: Boolean(projectId),
  });

  useEffect(() => {
    const globalBudget = budgets.data?.budgets.find((budget) => budget.scope === "global");
    if (!globalBudget) return;
    setBudgetTokens(globalBudget.tokenBudget ?? "");
    setBudgetCost(globalBudget.maxCostUsd ?? "");
  }, [budgets.data]);

  const saveBudget = useMutation({
    mutationFn: () =>
      rpc<{ saved: boolean; budget: BudgetRecord }>(
        "budgets.set",
        {
          scope: "global",
          project_id: projectId,
          token_budget: budgetTokens === "" ? undefined : Number(budgetTokens),
          max_cost_usd: budgetCost === "" ? undefined : Number(budgetCost),
          confirmed: true,
        },
        directory,
      ),
    onSuccess: async () => {
      setBudgetNotice("Presupuesto global guardado.");
      await queryClient.invalidateQueries({ queryKey: ["factory", "budgets", projectId] });
    },
    onError: (error) => setBudgetNotice(error instanceof Error ? error.message : String(error)),
  });

  const globalBudget = budgets.data?.budgets.find((budget) => budget.scope === "global");
  const openTasks =
    (overview.data?.tasks.pending ?? 0) +
    (overview.data?.tasks.in_progress ?? 0) +
    (overview.data?.tasks.blocked ?? 0);
  const error = overview.error ?? tasks.error ?? plans.error ?? gates.error ?? reviews.error;
  const refreshing = tasks.isFetching || plans.isFetching || gates.isFetching || reviews.isFetching;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Work"
        subtitle={
          <>
            Tareas, planes, compuertas y revisiones de{" "}
            <span className="text-ink">{project?.canonical ?? projectId}</span>. La fuente de verdad es PostgreSQL.
          </>
        }
        actions={
          <Button
            onClick={() => {
              void overview.refetch();
              void tasks.refetch();
              void plans.refetch();
              void gates.refetch();
              void reviews.refetch();
            }}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} /> Actualizar
          </Button>
        }
      />

      {error ? <ErrorState error={error} onRetry={() => void tasks.refetch()} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Tareas abiertas" value={openTasks} hint={`${tasks.data?.count ?? 0} en total`} icon={<ListChecks size={15} />} />
        <StatCard
          label="Planes"
          value={plans.data?.count ?? 0}
          hint={plans.data?.plans.filter((item) => item.status === "approved").length ? "con aprobados" : "sin aprobados"}
          icon={<Activity size={15} />}
          tone="violet"
        />
        <StatCard
          label="Gates con fallo"
          value={overview.data?.gates.fail ?? 0}
          hint={`${gates.data?.count ?? 0} ejecuciones`}
          icon={<XCircle size={15} />}
          tone={(overview.data?.gates.fail ?? 0) > 0 ? "danger" : "default"}
        />
        <StatCard
          label="Revisiones con cambios"
          value={overview.data?.reviews.changes_required ?? 0}
          hint={`${reviews.data?.count ?? 0} revisiones`}
          icon={<ShieldAlert size={15} />}
          tone={(overview.data?.reviews.changes_required ?? 0) > 0 ? "warning" : "default"}
        />
      </div>

      <Section
        title="Presupuesto"
        description="Reserva atómica por ejecución. Los presupuestos de fase y tarea se crean al lanzar tareas."
        actions={<Badge tone="violet"><Wallet size={12} /> global</Badge>}
      >
        <div className="grid gap-3 p-4 md:grid-cols-4">
          <Field label="Token budget global (ponderado)">
            <input
              type="number"
              min={0}
              step={100000}
              className="field"
              value={budgetTokens}
              placeholder="Sin límite"
              onChange={(event) => setBudgetTokens(event.target.value === "" ? "" : Number(event.target.value))}
            />
          </Field>
          <Field label="Máx. coste USD global">
            <input
              type="number"
              min={0}
              step={0.5}
              className="field"
              value={budgetCost}
              placeholder="Sin límite"
              onChange={(event) => setBudgetCost(event.target.value === "" ? "" : Number(event.target.value))}
            />
          </Field>
          <div className="rounded-lg border border-line-soft bg-carbon-950/50 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.08em] text-faint">Reservado</div>
            <div className="mt-1 text-sm text-ink">
              {formatCompact(globalBudget?.reservedWeightedTokens ?? 0)} tok pond. · {formatUsd(globalBudget?.reservedCostUsd ?? 0)}
            </div>
          </div>
          <div className="rounded-lg border border-line-soft bg-carbon-950/50 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.08em] text-faint">Gastado</div>
            <div className="mt-1 text-sm text-ink">
              {formatCompact(globalBudget?.spentWeightedTokens ?? 0)} tok pond. · {formatUsd(globalBudget?.spentCostUsd ?? 0)}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-4 py-3">
          <Button onClick={() => saveBudget.mutate()} disabled={saveBudget.isPending}>
            <Wallet size={14} /> Guardar presupuesto global
          </Button>
          {budgetNotice ? <span className="text-[11px] text-muted">{budgetNotice}</span> : null}
        </div>
      </Section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "tasks", label: "Tasks", count: tasks.data?.count },
            { value: "plans", label: "Plans", count: plans.data?.count },
            { value: "gates", label: "Gates", count: gates.data?.count },
            { value: "reviews", label: "Reviews", count: reviews.data?.count },
            { value: "runs", label: "Runs", count: executions.data?.count },
          ]}
        />
      </div>

      {tab === "tasks" ? (
        <Section title="Tareas" description="Criterios verificables y estado del tablero.">
          {tasks.isLoading ? (
            <Loading />
          ) : (tasks.data?.tasks.length ?? 0) === 0 ? (
            <EmptyState
              icon={<ListChecks size={26} />}
              title="Sin tareas"
              description="Crea tareas con factory desde el chat; aparecerán aquí."
            />
          ) : (
            <Table
              headers={["Tarea", "Estado", "Creada", "Cerrada", "Criterio"]}
              rows={tasks.data!.tasks.map((task) => [
                <div key="title">
                  <div className="text-xs font-medium text-ink">{task.title}</div>
                  <div className="font-mono text-[10px] text-faint">{task.id}</div>
                </div>,
                <StatusBadge key="status" value={task.status} />,
                <span key="created" className="text-[11px] text-muted">{formatDate(task.created_at)}</span>,
                <span key="closed" className="text-[11px] text-muted">{task.closed_at ? formatDate(task.closed_at) : "—"}</span>,
                <span key="criteria" className="line-clamp-2 max-w-[420px] text-[11px] text-muted">{task.acceptance_criteria}</span>,
              ])}
            />
          )}
        </Section>
      ) : null}

      {tab === "plans" ? (
        <Section title="Planes" description="Progreso por tareas y estado de revisión.">
          {plans.isLoading ? (
            <Loading />
          ) : (plans.data?.plans.length ?? 0) === 0 ? (
            <EmptyState title="Sin planes" description="Crea un plan por fases desde el chat." />
          ) : (
            <div className="divide-y divide-line-soft">
              {plans.data!.plans.map((item) => {
                const done = item.tasks_done + item.tasks_merged;
                const progress = percent(done, item.tasks_total);
                return (
                  <button
                    key={item.id}
                    className="block w-full px-4 py-3 text-left transition-colors hover:bg-carbon-850/70"
                    onClick={() => setPlanId(item.id)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-ink">{item.title}</span>
                      <StatusBadge value={item.status} />
                      <Badge tone="violet">{item.autonomy}</Badge>
                      {item.review_exhausted ? <Badge tone="danger">review exhausted</Badge> : null}
                      <span className="ml-auto text-[10px] text-faint">{formatDate(item.created_at)}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <ProgressBar value={progress} />
                      <span className="shrink-0 text-[10px] text-muted">
                        {done}/{item.tasks_total} · {progress}%
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-faint">
                      <span>{item.tasks_running} en ejecución</span>
                      <span>{item.tasks_failed} fallidas</span>
                      <span>ronda de revisión {item.review_round}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Section>
      ) : null}

      {tab === "gates" ? (
        <Section title="Gates" description="Compuertas deterministas y su evidencia.">
          {gates.isLoading ? (
            <Loading />
          ) : (gates.data?.gates.length ?? 0) === 0 ? (
            <EmptyState title="Sin gates" description="Ejecuta run_gates para generar evidencia." />
          ) : (
            <Table
              headers={["Estado", "Modo", "Iteración", "Resumen", "Rama", "Fecha"]}
              rows={gates.data!.gates.map((gate) => [
                <StatusBadge key="status" value={gate.status} />,
                <span key="mode" className="text-[11px] text-muted">{gate.mode}</span>,
                <span key="iteration" className="text-[11px] text-muted">{gate.iteration}</span>,
                <span key="summary" className="line-clamp-2 max-w-[460px] text-[11px] text-muted">{gate.summary ?? "—"}</span>,
                <span key="branch" className="font-mono text-[10px] text-muted">{gate.git_branch ?? "—"}</span>,
                <span key="date" className="text-[11px] text-muted">{formatDate(gate.created_at)}</span>,
              ])}
            />
          )}
        </Section>
      ) : null}

      {tab === "reviews" ? (
        <Section title="Reviews" description="Veredictos independientes y coste por modelo.">
          {reviews.isLoading ? (
            <Loading />
          ) : (reviews.data?.reviews.length ?? 0) === 0 ? (
            <EmptyState title="Sin revisiones" description="Las revisiones aparecen al cerrar tareas o fases." />
          ) : (
            <Table
              headers={["Rol", "Modelo", "Veredicto", "Bloqueantes", "Coste", "Fecha"]}
              rows={reviews.data!.reviews.map((review) => [
                <span key="role" className="text-[11px] font-medium text-ink">{review.role}</span>,
                <span key="model" className="font-mono text-[10px] text-muted">{review.model}</span>,
                <StatusBadge key="verdict" value={review.verdict} />,
                <span key="blocking" className="text-[11px] text-muted">{review.open_blocking}</span>,
                <span key="cost" className="text-[11px] text-muted">{formatUsd(review.cost_usd)}</span>,
                <span key="date" className="text-[11px] text-muted">{formatDate(review.created_at)}</span>,
              ])}
            />
          )}
        </Section>
      ) : null}

      {tab === "runs" ? (
        <Section
          title="Runs"
          description="Execution log: agente, modelo, tokens, coste, estado, intento y motivo de selección."
        >
          {executions.isLoading ? (
            <Loading />
          ) : executions.isError ? (
            <ErrorState error={executions.error} onRetry={() => void executions.refetch()} />
          ) : (executions.data?.executions.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Activity size={26} />}
              title="Sin ejecuciones registradas"
              description="Las ejecuciones de subtask_run y review_run aparecerán aquí con su coste y modelo."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead className="bg-carbon-850">
                  <tr>
                    <th className="table-head px-4 py-2.5">Inicio</th>
                    <th className="table-head px-4 py-2.5">Agente</th>
                    <th className="table-head px-4 py-2.5">Rol</th>
                    <th className="table-head px-4 py-2.5">Modelo</th>
                    <th className="table-head px-4 py-2.5">Estado</th>
                    <th className="table-head px-4 py-2.5">Tokens (in/cache/out)</th>
                    <th className="table-head px-4 py-2.5">Reserva / overrun</th>
                    <th className="table-head px-4 py-2.5">Coste</th>
                    <th className="table-head px-4 py-2.5">Duración</th>
                    <th className="table-head px-4 py-2.5">Motivo / error</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.data!.executions.map((execution) => (
                    <tr key={execution.id} className="table-row">
                      <td className="px-4 py-2.5 text-[11px] text-muted">{formatDate(execution.startedAt)}</td>
                      <td className="px-4 py-2.5 text-[11px] font-medium text-ink">{execution.agentId ?? "—"}</td>
                      <td className="px-4 py-2.5 text-[11px] text-muted">{execution.role ?? "—"}</td>
                      <td className="px-4 py-2.5 font-mono text-[10px] text-muted">
                        {execution.providerId && execution.modelId
                          ? `${execution.providerId}/${execution.modelId}`
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5"><StatusBadge value={execution.status ?? "—"} /></td>
                      <td className="px-4 py-2.5 text-[10px] text-muted">
                        <div>
                          in {formatCompact(execution.tokensInput)} · cR {formatCompact(execution.tokensCacheRead)} · out{" "}
                          {formatCompact(execution.tokensOutput)}
                        </div>
                        <div className="text-faint">
                          pond. {formatCompact(execution.weightedTokens)} · raz.{" "}
                          {formatCompact(execution.tokensReasoning)}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-[10px] text-muted">
                        <div>
                          {execution.budgetUnit === "cost"
                            ? formatUsd(execution.reservedCostUsd)
                            : `${formatCompact(execution.reservedWeightedTokens ?? 0)} pond.`}
                        </div>
                        <div className="text-faint">
                          {execution.overrunRatio !== null
                            ? `${Math.round(execution.overrunRatio * 100)}%`
                            : "—"}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-muted">{formatUsd(execution.costUsd)}</td>
                      <td className="px-4 py-2.5 text-[11px] text-muted">
                        {duration(execution.startedAt, execution.finishedAt)}
                      </td>
                      <td className="max-w-[320px] px-4 py-2.5 text-[11px] text-muted">
                        <span className="line-clamp-2">{execution.error ?? execution.selectionReason ?? "—"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}

      <Modal
        open={Boolean(planId)}
        title={String((plan.data?.plan as Record<string, unknown> | undefined)?.title ?? "Plan")}
        description="Detalle del plan, tareas y revisiones."
        onClose={() => setPlanId(null)}
        width="max-w-3xl"
      >
        {plan.isLoading ? (
          <Spinner />
        ) : plan.isError ? (
          <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
              <Detail label="Estado" value={String((plan.data?.plan as Record<string, unknown>)?.status ?? "—")} />
              <Detail label="Autonomía" value={String((plan.data?.plan as Record<string, unknown>)?.autonomy ?? "—")} />
              <Detail label="Tareas" value={String((plan.data?.tasks as unknown[] | undefined)?.length ?? 0)} />
              <Detail label="Revisiones" value={String((plan.data?.reviews as unknown[] | undefined)?.length ?? 0)} />
            </div>
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Tareas</div>
              <div className="max-h-[320px] space-y-1 overflow-auto">
                {(plan.data?.tasks as Array<Record<string, unknown>> | undefined)?.map((task) => (
                  <div key={String(task.id)} className="flex items-center gap-2 rounded-md border border-line-soft px-2.5 py-2">
                    <span className="truncate text-[11px] text-ink">{String(task.title ?? "—")}</span>
                    <StatusBadge value={String(task.status ?? "—")} />
                    <span className="ml-auto text-[10px] text-faint">{String(task.assignee ?? "—")}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Loading() {
  return (
    <div className="p-6">
      <Spinner />
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead className="bg-carbon-850">
          <tr>
            {headers.map((header) => (
              <th key={header} className="table-head px-4 py-2.5">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="table-row">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-4 py-2.5 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  return <span className={cn("badge", statusClass(value))}>{value}</span>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line-soft bg-carbon-950/60 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-faint">{label}</div>
      <div className="mt-0.5 text-xs text-ink">{value}</div>
    </div>
  );
}

function duration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "en curso";
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
