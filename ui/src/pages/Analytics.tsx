import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BarChart3, DollarSign, Gauge, Wrench } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useProject } from "../components/ProjectContext";
import { Badge, EmptyState, ErrorState, PageHeader, Section, Spinner, StatCard } from "../components/ui";
import { api } from "../lib/api";
import { formatCompact, formatNumber, formatUsd } from "../lib/format";
import { rpc } from "../lib/rpc";
import type { AnalyticsSummary, ModelHistoryRecord, SessionStats } from "../lib/types";

const tooltipStyle = {
  background: "#0f131a",
  border: "1px solid #222a38",
  borderRadius: 8,
  fontSize: 12,
  color: "#e6edf3",
};

const COLORS = ["#7c5cff", "#a78bfa", "#3fb950", "#d29922", "#f85149", "#38bdf8", "#f472b6"];

export function AnalyticsPage() {
  const { projectId, project } = useProject();
  const directory = project?.canonical;
  const [historyRole, setHistoryRole] = useState("implementer");
  const analytics = useQuery({
    queryKey: ["factory", "analytics", projectId, 30],
    queryFn: () => rpc<AnalyticsSummary>("analytics.summary", { project_id: projectId, days: 30 }, directory),
    enabled: Boolean(projectId),
  });
  const stats = useQuery({ queryKey: ["opencode", "stats", directory ?? "default"], queryFn: () => api.stats(directory) });
  const history = useQuery({
    queryKey: ["factory", "model-history", historyRole, directory ?? "default"],
    queryFn: () =>
      rpc<{ role: string; count: number; history: ModelHistoryRecord[] }>(
        "models.history",
        { role: historyRole },
        directory,
      ),
    enabled: Boolean(projectId),
  });

  const totals = analytics.data?.totals ?? {};
  const logCost = Number(totals.execution_cost ?? 0);
  const cost = logCost > 0 ? logCost : Number(totals.subtask_cost ?? 0) + Number(totals.review_cost ?? 0);
  const totalRuns = (analytics.data?.by_model ?? []).reduce((sum, row) => sum + row.runs, 0);
  const totalTokens = (analytics.data?.by_model ?? []).reduce(
    (sum, row) => sum + Number(row.tokens_input ?? 0) + Number(row.tokens_output ?? 0),
    0,
  );
  const toolSuccess = stats.data
    ? Math.round((stats.data.tools.totals.succeeded / Math.max(stats.data.tools.totals.calls, 1)) * 100)
    : 0;

  const byDay = (analytics.data?.by_day ?? []).map((row) => ({
    day: row.day,
    cost: Number(row.cost ?? 0),
    runs: Number(row.runs ?? 0),
  }));
  const byModel = (analytics.data?.by_model ?? []).map((row) => ({
    model: row.model,
    cost: Number(row.cost ?? 0),
    runs: Number(row.runs ?? 0),
  }));
  const byRole = (analytics.data?.by_role ?? []).map((row) => ({
    role: row.role,
    cost: Number(row.cost ?? 0),
    runs: Number(row.runs ?? 0),
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        subtitle="Consumo, coste y rendimiento de la fábrica. El coste de catálogo es una estimación; no es una factura."
        actions={
          <Badge tone="violet">
            fuente: {analytics.data?.source === "execution_log" ? "execution log" : "subtasks/reviews"}
          </Badge>
        }
      />

      {analytics.error || stats.error ? (
        <ErrorState error={analytics.error ?? stats.error} onRetry={() => void analytics.refetch()} />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Coste 30 días" value={formatUsd(cost)} hint="subtasks + revisiones" icon={<DollarSign size={15} />} tone="success" />
        <StatCard label="Ejecuciones" value={formatNumber(totalRuns)} hint="subtasks y reviews" icon={<BarChart3 size={15} />} />
        <StatCard label="Tokens" value={formatCompact(totalTokens)} hint="entrada + salida" icon={<Gauge size={15} />} tone="violet" />
        <StatCard
          label="Tool success"
          value={stats.data ? `${toolSuccess}%` : "—"}
          hint={stats.data ? `${formatNumber(stats.data.tools.totals.calls)} llamadas` : undefined}
          icon={<Wrench size={15} />}
          tone={toolSuccess >= 95 ? "success" : "warning"}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Section title="Coste por día" description="Estimación de catálogo de los últimos 30 días.">
          <div className="h-[300px] px-3 py-4">
            {analytics.isLoading ? (
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            ) : byDay.length === 0 ? (
              <EmptyState title="Sin datos" description="No hay ejecuciones registradas en el periodo." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byDay}>
                  <CartesianGrid stroke="#1a202b" vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: "#5d6673", fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#5d6673", fontSize: 10 }} axisLine={false} tickLine={false} width={46} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatUsd(Number(value ?? 0))} />
                  <Bar dataKey="cost" fill="#7c5cff" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Section>

        <Section title="Coste por rol" description="Revisiones y QA por rol.">
          <div className="h-[300px] px-3 py-4">
            {byRole.length === 0 ? (
              <EmptyState title="Sin datos" description="Aún no hay revisiones." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={byRole} dataKey="cost" nameKey="role" innerRadius={58} outerRadius={92} paddingAngle={2}>
                    {byRole.map((entry, index) => (
                      <Cell key={entry.role} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatUsd(Number(value ?? 0))} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </Section>
      </div>

      <Section title="Por modelo" description="Coste, tokens y número de ejecuciones.">
        {byModel.length === 0 ? (
          <EmptyState icon={<BarChart3 size={26} />} title="Sin datos" description="Ejecuta tareas y revisiones para poblar Analytics." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="bg-carbon-850">
                <tr>
                  <th className="table-head px-4 py-2.5">Modelo</th>
                  <th className="table-head px-4 py-2.5">Ejecuciones</th>
                  <th className="table-head px-4 py-2.5">Tokens entrada</th>
                  <th className="table-head px-4 py-2.5">Tokens salida</th>
                  <th className="table-head px-4 py-2.5">Coste</th>
                </tr>
              </thead>
              <tbody>
                {analytics.data?.by_model.map((row) => (
                  <tr key={row.model} className="table-row">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink">{row.model}</td>
                    <td className="px-4 py-2.5 text-[11px] text-muted">{row.runs}</td>
                    <td className="px-4 py-2.5 text-[11px] text-muted">{formatCompact(Number(row.tokens_input ?? 0))}</td>
                    <td className="px-4 py-2.5 text-[11px] text-muted">{formatCompact(Number(row.tokens_output ?? 0))}</td>
                    <td className="px-4 py-2.5 text-[11px] text-muted">{formatUsd(row.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Historial por rol"
        description="Tasa de éxito, coste medio y tokens medios por modelo según el execution log."
        actions={
          <select
            className="field h-8 w-40 text-xs"
            value={historyRole}
            onChange={(event) => setHistoryRole(event.target.value)}
          >
            {["implementer", "code", "qa", "security", "plan", "orchestration"].map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        }
      >
        {history.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : (history.data?.history.length ?? 0) === 0 ? (
          <EmptyState title="Sin historial" description="Aún no hay ejecuciones cerradas para este rol." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="bg-carbon-850">
                <tr>
                  <th className="table-head px-4 py-2.5">Modelo</th>
                  <th className="table-head px-4 py-2.5">Ejecuciones</th>
                  <th className="table-head px-4 py-2.5">Éxito</th>
                  <th className="table-head px-4 py-2.5">Coste medio</th>
                  <th className="table-head px-4 py-2.5">Tokens medios</th>
                </tr>
              </thead>
              <tbody>
                {history.data!.history.map((row) => (
                  <tr key={`${row.providerId}/${row.modelId}`} className="table-row">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink">
                      {row.providerId}/{row.modelId}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-muted">{row.runs}</td>
                    <td className="px-4 py-2.5 text-[11px] text-muted">
                      {row.runs > 0 ? `${Math.round((row.successes / row.runs) * 100)}%` : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-muted">{formatUsd(row.avgCostUsd)}</td>
                    <td className="px-4 py-2.5 text-[11px] text-muted">
                      {row.avgTokens !== null ? formatCompact(row.avgTokens) : "—"}
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
