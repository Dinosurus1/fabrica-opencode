import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Brain,
  CheckCircle2,
  Cpu,
  DollarSign,
  ListChecks,
  MessagesSquare,
  ShieldAlert,
  Users,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useProject } from "../components/ProjectContext";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Section, Spinner, StatCard } from "../components/ui";
import { api } from "../lib/api";
import { cn, formatCompact, formatDate, formatNumber, formatUsd, modelLabel, statusClass } from "../lib/format";
import { useFactoryHealth } from "../lib/hooks";
import { rpc } from "../lib/rpc";
import type { AnalyticsSummary, SessionStats, WorkOverview } from "../lib/types";

const tooltipStyle = {
  background: "#0f131a",
  border: "1px solid #222a38",
  borderRadius: 8,
  fontSize: 12,
  color: "#e6edf3",
};

export function OverviewPage() {
  const { project, projectId } = useProject();
  const directory = project?.canonical;
  const health = useFactoryHealth(directory);
  const overview = useQuery({
    queryKey: ["factory", "work-overview", projectId],
    queryFn: () => rpc<WorkOverview>("work.overview", { project_id: projectId }, directory),
    enabled: Boolean(projectId),
  });
  const stats = useQuery({ queryKey: ["opencode", "stats", directory ?? "default"], queryFn: () => api.stats(directory) });
  const analytics = useQuery({
    queryKey: ["factory", "analytics", projectId, 30],
    queryFn: () => rpc<AnalyticsSummary>("analytics.summary", { project_id: projectId, days: 30 }, directory),
    enabled: Boolean(projectId),
  });

  if (!projectId) {
    return (
      <EmptyState
        icon={<ListChecks size={28} />}
        title="No hay un proyecto seleccionado"
        description="Selecciona un proyecto en la barra superior para ver el estado de la fábrica."
      />
    );
  }

  const totals = analytics.data?.totals ?? {};
  const cost30d =
    Number(totals.subtask_cost ?? 0) + Number(totals.review_cost ?? 0);
  const tasksOpen =
    (overview.data?.tasks?.pending ?? 0) +
    (overview.data?.tasks?.in_progress ?? 0) +
    (overview.data?.tasks?.blocked ?? 0);
  const gatesFail = overview.data?.gates?.fail ?? 0;
  const reviewsChanges = overview.data?.reviews?.changes_required ?? 0;
  const modelUsage = (overview.data?.model_usage ?? [])
    .map((row) => ({ ...row, cost: Number(row.cost ?? 0) }))
    .sort((left, right) => right.cost - left.cost);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Overview"
        subtitle={
          <>
            Estado de <span className="text-ink">{project?.canonical ?? projectId}</span> · fábrica,
            sesiones y consumo reciente.
          </>
        }
        actions={
          <Badge tone={health.data?.ok ? "success" : "danger"}>
            <span className={cn("size-1.5 rounded-full", health.data?.ok ? "bg-success" : "bg-danger")} />
            {health.data?.ok ? "Operativa" : "Sin conexión"}
          </Badge>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Sesiones"
          value={stats.data ? formatNumber(stats.data.sessions) : "—"}
          hint={stats.data ? `${stats.data.activeDays} días activos · racha ${stats.data.streak}` : undefined}
          icon={<MessagesSquare size={15} />}
        />
        <StatCard
          label="Steps"
          value={stats.data ? formatCompact(stats.data.steps) : "—"}
          hint={stats.data ? `${formatCompact(stats.data.prompts)} prompts` : undefined}
          icon={<Activity size={15} />}
          tone="violet"
        />
        <StatCard
          label="Tokens"
          value={
            stats.data
              ? formatCompact(stats.data.tokens.input + stats.data.tokens.output + stats.data.tokens.reasoning)
              : "—"
          }
          hint={stats.data ? `caché ${formatCompact(stats.data.tokens.cache?.read ?? 0)}` : undefined}
          icon={<Cpu size={15} />}
        />
        <StatCard
          label="Coste 30 días"
          value={formatUsd(cost30d)}
          hint="subtasks + revisiones"
          icon={<DollarSign size={15} />}
          tone="success"
        />
        <StatCard
          label="Trabajo abierto"
          value={formatNumber(tasksOpen)}
          hint={`${gatesFail} gates con fallo · ${reviewsChanges} revisiones con cambios`}
          icon={<ListChecks size={15} />}
          tone={gatesFail > 0 ? "danger" : "default"}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <Section
          title="Actividad"
          description="Steps por día en los últimos días activos."
          actions={<Badge tone="violet">{stats.data?.tools.totals.calls ?? 0} tool calls</Badge>}
        >
          <div className="h-[260px] px-3 py-4">
            {stats.isLoading ? (
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            ) : stats.isError ? (
              <ErrorState error={stats.error} onRetry={() => stats.refetch()} />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={stats.data?.activity ?? []}>
                  <defs>
                    <linearGradient id="activity-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7c5cff" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#7c5cff" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1a202b" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#5d6673", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "#5d6673", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                  />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Area
                    type="monotone"
                    dataKey="steps"
                    stroke="#a78bfa"
                    strokeWidth={2}
                    fill="url(#activity-fill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Section>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Salud de la fábrica</h2>
            <Badge tone={health.data?.memory_available ? "success" : "warning"}>
              <Brain size={12} /> memoria {health.data?.memory_available ? "ok" : "no"}
            </Badge>
          </div>
          <div className="mt-4 space-y-3 text-sm">
            <HealthRow icon={<Cpu size={14} />} label="Modelos" value={health.data?.models ?? "—"} />
            <HealthRow icon={<Users size={14} />} label="Agentes" value={health.data?.agents ?? "—"} />
            <HealthRow
              icon={<ShieldAlert size={14} />}
              label="Perfiles"
              value={health.data?.profiles ?? "—"}
            />
            <HealthRow
              icon={<CheckCircle2 size={14} />}
              label="Perfil por defecto"
              value={health.data?.default_profile ?? "—"}
            />
            <HealthRow
              icon={<ShieldAlert size={14} />}
              label="Perfil aplicado"
              value={health.data?.applied_profile ?? "—"}
            />
          </div>
          <div className="mt-4 border-t border-line-soft pt-3 text-[11px] leading-5 text-faint">
            {health.data
              ? `Comprobado ${formatDate(health.data.checked_at)}. La fuente de verdad es PostgreSQL; los modelos se aplican por perfil.`
              : "Sin datos de salud. Revisa Settings o factory_doctor."}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
        <Section title="Uso por modelo" description="Coste de subtasks y revisiones en 30 días.">
          <div className="h-[260px] px-3 py-4">
            {overview.isLoading ? (
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            ) : overview.isError ? (
              <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
            ) : (overview.data?.model_usage.length ?? 0) === 0 ? (
              <EmptyState title="Sin ejecuciones registradas" description="Aún no hay coste por modelo." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={modelUsage} layout="vertical" margin={{ left: 8 }}>
                  <CartesianGrid stroke="#1a202b" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "#5d6673", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis
                    type="category"
                    dataKey="model"
                    width={170}
                    tick={{ fill: "#8b949e", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatUsd(Number(value ?? 0))} />
                  <Bar dataKey="cost" fill="#7c5cff" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Section>

        <Section title="Actividad reciente" description="Últimas tareas, gates y revisiones del proyecto.">
          <div className="divide-y divide-line-soft">
            {(overview.data?.recent.tasks ?? []).map((task) => (
              <div key={String(task.id)} className="flex items-center gap-3 px-4 py-2.5">
                <ListChecks size={14} className="shrink-0 text-faint" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-ink">{String(task.title ?? "Tarea")}</div>
                  <div className="text-[11px] text-faint">{formatDate(String(task.created_at ?? ""))}</div>
                </div>
                <span className={cn("badge", statusClass(String(task.status ?? "")))}>
                  {String(task.status ?? "—")}
                </span>
              </div>
            ))}
            {(overview.data?.recent.gates ?? []).map((gate) => (
              <div key={String(gate.id)} className="flex items-center gap-3 px-4 py-2.5">
                <Activity size={14} className="shrink-0 text-faint" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-ink">
                    Gate {String(gate.mode ?? "")} · {String(gate.summary ?? "sin resumen")}
                  </div>
                  <div className="text-[11px] text-faint">{formatDate(String(gate.created_at ?? ""))}</div>
                </div>
                <span className={cn("badge", statusClass(String(gate.status ?? "")))}>
                  {String(gate.status ?? "—")}
                </span>
              </div>
            ))}
            {(overview.data?.recent.reviews ?? []).map((review) => (
              <div key={String(review.id)} className="flex items-center gap-3 px-4 py-2.5">
                <ShieldAlert size={14} className="shrink-0 text-faint" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-ink">
                    {String(review.role ?? "review")} · {modelLabel(String(review.model ?? "").split("/")[0], String(review.model ?? "").split("/").slice(1).join("/"))}
                  </div>
                  <div className="text-[11px] text-faint">{formatDate(String(review.created_at ?? ""))}</div>
                </div>
                <span className={cn("badge", statusClass(String(review.verdict ?? "")))}>
                  {String(review.verdict ?? "—")}
                </span>
              </div>
            ))}
            {(overview.data?.recent.tasks.length ?? 0) +
              (overview.data?.recent.gates.length ?? 0) +
              (overview.data?.recent.reviews.length ?? 0) ===
            0 ? (
              <EmptyState
                title="Sin actividad reciente"
                description="Las tareas, gates y revisiones aparecerán aquí cuando la fábrica ejecute trabajo."
              />
            ) : null}
          </div>
        </Section>
      </div>
    </div>
  );
}

function HealthRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-faint">{icon}</span>
      <span className="text-muted">{label}</span>
      <span className="ml-auto font-medium text-ink">{value}</span>
    </div>
  );
}
