/**
 * Handlers del RPC de la fábrica.
 *
 * Expone al cliente web (y a otros plugins) el catálogo MAM, los perfiles de
 * ejecución, el estado de trabajo, la memoria y analítica. Las mutaciones
 * sensibles exigen `confirmed=true` y quedan auditadas.
 */

import type { QueryFn } from "../../tools/factory/db.js";
import {
  AGENT_CATALOG,
  applySelectionPermissions,
  approvedFor,
  getSelection,
  recommendAgents,
  validateSelected,
  type AgentMode,
} from "../../tools/factory/agents.js";
import {
  applyProfileFromStore,
  parseProfileInput,
  syncCatalogFromRuntime,
  validateProfileInput,
  type MamRuntime,
} from "../../tools/factory/mam.js";

export interface FactoryRpcDeps {
  mam: MamRuntime;
  query: QueryFn;
  defaultProjectId: string;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}

function projectId(input: Record<string, unknown>, fallback: string): string {
  return asString(input.project_id) || fallback;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = value instanceof Date ? value.toISOString() : value;
  }
  return result;
}

function countsBy(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const name = String(row[key] ?? "unknown");
    result[name] = Number(row.count ?? 0);
  }
  return result;
}

export function createFactoryRpcHandlers(deps: FactoryRpcDeps) {
  const { mam, query } = deps;

  return {
    async health() {
      const [models, agents, profiles, memory, applied] = await Promise.all([
        mam.store.listModels({ limit: 2_000 }),
        mam.store.listAgents(),
        mam.store.listProfiles(),
        mam.store.memoryStats().catch(() => null),
        mam.store.getAppliedProfile(mam.location),
      ]);
      return {
        ok: true,
        project_id: deps.defaultProjectId,
        checked_at: new Date().toISOString(),
        models: models.length,
        agents: agents.length,
        profiles: profiles.length,
        memory_available: memory !== null,
        default_profile:
          profiles.find((profile) => profile.isDefault)?.name ?? null,
        applied_profile_id: applied,
        applied_profile: profiles.find((profile) => profile.id === applied)?.name ?? null,
      };
    },

    async "work.overview"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const [tasks, plans, gates, reviews, recentTasks, recentGates, recentReviews, usage] =
        await Promise.all([
          query<Record<string, unknown>>(
            `SELECT status, count(*)::int AS count FROM tasks WHERE project_id = $1 GROUP BY status`,
            [project],
          ),
          query<Record<string, unknown>>(
            `SELECT status, count(*)::int AS count FROM plans WHERE project_id = $1 GROUP BY status`,
            [project],
          ),
          query<Record<string, unknown>>(
            `SELECT status, count(*)::int AS count FROM gate_runs
             WHERE project_id = $1 AND created_at > now() - interval '30 days'
             GROUP BY status`,
            [project],
          ),
          query<Record<string, unknown>>(
            `SELECT verdict, count(*)::int AS count FROM review_runs
             WHERE project_id = $1 AND created_at > now() - interval '30 days'
             GROUP BY verdict`,
            [project],
          ),
          query<Record<string, unknown>>(
            `SELECT id, title, status, acceptance_criteria, created_at, closed_at
             FROM tasks WHERE project_id = $1 ORDER BY created_at DESC LIMIT 5`,
            [project],
          ),
          query<Record<string, unknown>>(
            `SELECT id, status, summary, mode, created_at FROM gate_runs
             WHERE project_id = $1 ORDER BY created_at DESC LIMIT 5`,
            [project],
          ),
          query<Record<string, unknown>>(
            `SELECT id, role, model, verdict, open_blocking, created_at FROM review_runs
             WHERE project_id = $1 ORDER BY created_at DESC LIMIT 5`,
            [project],
          ),
          query<Record<string, unknown>>(
            `SELECT model, sum(cost_usd)::numeric AS cost, count(*)::int AS runs
             FROM (
               SELECT model, cost_usd FROM subtask_runs
               WHERE started_at > now() - interval '30 days'
               UNION ALL
               SELECT model, cost_usd FROM review_runs
               WHERE created_at > now() - interval '30 days'
             ) runs
             GROUP BY model ORDER BY cost DESC NULLS LAST LIMIT 8`,
          ),
        ]);

      return {
        project_id: project,
        tasks: countsBy(tasks.rows, "status"),
        plans: countsBy(plans.rows, "status"),
        gates: countsBy(gates.rows, "status"),
        reviews: countsBy(reviews.rows, "verdict"),
        recent: {
          tasks: recentTasks.rows.map(serializeRow),
          gates: recentGates.rows.map(serializeRow),
          reviews: recentReviews.rows.map(serializeRow),
        },
        model_usage: usage.rows.map(serializeRow),
      };
    },

    async "models.list"(input: Record<string, unknown>) {
      const models = await mam.store.listModels({
        providerId: asString(input.provider_id) || undefined,
        family: asString(input.family) || undefined,
        status: asString(input.status) || undefined,
        authorized: typeof input.authorized === "boolean" ? input.authorized : undefined,
        prohibited: typeof input.prohibited === "boolean" ? input.prohibited : undefined,
        enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
        search: asString(input.search) || undefined,
        limit: asNumber(input.limit, 500),
      });
      return { count: models.length, models };
    },

    async "models.sync"() {
      const { counts, defaultProfile } = await syncCatalogFromRuntime(mam);
      return {
        synced: counts,
        default_profile: defaultProfile
          ? { id: defaultProfile.id, name: defaultProfile.name, assignments: defaultProfile.assignments.length }
          : null,
      };
    },

    async "agents.list"() {
      const agents = await mam.store.listAgents();
      return { count: agents.length, agents };
    },

    async "profiles.list"() {
      const [profiles, applied] = await Promise.all([
        mam.store.listProfiles(),
        mam.store.getAppliedProfile(mam.location),
      ]);
      return { count: profiles.length, profiles, applied_profile_id: applied };
    },

    async "profiles.get"(input: Record<string, unknown>) {
      const id = asString(input.id);
      if (!id) throw new Error("Falta el id del perfil.");
      const profile = await mam.store.getProfile(id);
      if (!profile) throw new Error("El perfil no existe.");
      const applied = await mam.store.getAppliedProfile(mam.location);
      return { ...profile, applied: applied === profile.id };
    },

    async "profiles.validate"(input: Record<string, unknown>) {
      const profile = parseProfileInput(input);
      const issues = await validateProfileInput(mam.store, profile);
      return { valid: !issues.some((issue) => issue.severity === "error"), issues };
    },

    async "profiles.upsert"(input: Record<string, unknown>) {
      const profile = parseProfileInput(input);
      const issues = await validateProfileInput(mam.store, profile);
      const errors = issues.filter((issue) => issue.severity === "error");
      if (errors.length > 0) return { saved: false, issues };
      const saved = await mam.store.upsertProfile(profile);
      await mam.store.audit("profile.set", saved.id, {
        name: saved.name,
        mode: saved.mode,
        assignments: saved.assignments.length,
        isDefault: saved.isDefault,
      });
      return { saved: true, profile: saved, issues };
    },

    async "profiles.apply"(input: Record<string, unknown>) {
      const id = asString(input.id);
      if (!id) throw new Error("Falta el id del perfil.");
      const profile = await mam.store.getProfile(id);
      if (!profile) throw new Error("El perfil no existe.");
      const issues = await validateProfileInput(mam.store, {
        id: profile.id,
        name: profile.name,
        description: profile.description,
        mode: profile.mode,
        isDefault: profile.isDefault,
        policy: profile.policy,
        assignments: profile.assignments,
      });
      if (issues.some((issue) => issue.severity === "error")) {
        return { applied: false, issues, requires_fix: true };
      }
      if (input.confirmed !== true) {
        return {
          applied: false,
          requires_confirmation: true,
          profile: { id: profile.id, name: profile.name, assignments: profile.assignments },
          issues,
        };
      }
      const result = await applyProfileFromStore(mam, profile, {
        makeDefault: input.make_default === true,
        sessionId: asString(input.session_id) || undefined,
      });
      await mam.store.audit("profile.apply", profile.id, {
        name: profile.name,
        makeDefault: input.make_default === true,
        sessionId: asString(input.session_id) || null,
        assignments: profile.assignments.length,
      });
      return {
        applied: true,
        profile: {
          id: profile.id,
          name: profile.name,
          isDefault: input.make_default === true || profile.isDefault,
        },
        session_updated: result.sessionUpdated,
        warnings: result.warnings,
        issues,
      };
    },

    async "profiles.delete"(input: Record<string, unknown>) {
      const id = asString(input.id);
      if (!id) throw new Error("Falta el id del perfil.");
      if (input.confirmed !== true) return { deleted: false, requires_confirmation: true };
      const profile = await mam.store.getProfile(id);
      if (!profile) throw new Error("El perfil no existe.");
      const deleted = await mam.store.deleteProfile(id);
      await mam.store.audit("profile.delete", id, { name: profile.name });
      return { deleted, id };
    },

    async "work.tasks"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const values: unknown[] = [project];
      const conditions = ["project_id = $1"];
      if (asString(input.status)) {
        values.push(asString(input.status));
        conditions.push(`status = $${values.length}`);
      }
      if (asString(input.search)) {
        values.push(`%${asString(input.search)}%`);
        conditions.push(`(title ILIKE $${values.length} OR acceptance_criteria ILIKE $${values.length})`);
      }
      values.push(asNumber(input.limit, 50));
      const result = await query<Record<string, unknown>>(
        `SELECT id, project_id, project_path, title, acceptance_criteria, status,
                result, closure_report, closed_at, created_at, updated_at
         FROM tasks WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC LIMIT $${values.length}`,
        values,
      );
      return { count: result.rows.length, tasks: result.rows.map(serializeRow) };
    },

    async "work.plans"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const limit = asNumber(input.limit, 30);
      const result = await query<Record<string, unknown>>(
        `SELECT p.id, p.project_id, p.title, p.status, p.autonomy, p.max_concurrency,
                p.review_round, p.review_exhausted, p.created_at, p.updated_at, p.approved_at,
                count(t.id)::int AS tasks_total,
                count(t.id) FILTER (WHERE t.status = 'done')::int AS tasks_done,
                count(t.id) FILTER (WHERE t.status = 'merged')::int AS tasks_merged,
                count(t.id) FILTER (WHERE t.status = 'running')::int AS tasks_running,
                count(t.id) FILTER (WHERE t.status = 'failed')::int AS tasks_failed
         FROM plans p
         LEFT JOIN plan_tasks t ON t.plan_id = p.id
         WHERE p.project_id = $1
         GROUP BY p.id
         ORDER BY p.created_at DESC LIMIT $2`,
        [project, limit],
      );
      return { count: result.rows.length, plans: result.rows.map(serializeRow) };
    },

    async "work.plan"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const planId = asString(input.plan_id);
      if (!planId) throw new Error("Falta plan_id.");
      const [plan, tasks, reviews, validations] = await Promise.all([
        query<Record<string, unknown>>(`SELECT * FROM plans WHERE project_id = $1 AND id = $2`, [project, planId]),
        query<Record<string, unknown>>(
          `SELECT * FROM plan_tasks WHERE plan_id = $1 ORDER BY phase, created_at`,
          [planId],
        ),
        query<Record<string, unknown>>(
          `SELECT * FROM plan_reviews WHERE plan_id = $1 ORDER BY round DESC, created_at DESC`,
          [planId],
        ),
        query<Record<string, unknown>>(
          `SELECT * FROM plan_validations WHERE plan_id = $1 ORDER BY created_at DESC`,
          [planId],
        ),
      ]);
      if (!plan.rows[0]) throw new Error("El plan no existe.");
      return {
        plan: serializeRow(plan.rows[0]),
        tasks: tasks.rows.map(serializeRow),
        reviews: reviews.rows.map(serializeRow),
        validations: validations.rows.map(serializeRow),
      };
    },

    async "work.gates"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const result = await query<Record<string, unknown>>(
        `SELECT id, project_id, task_id, iteration, mode, status, summary,
                blocking_failures, warnings, git_branch, git_commit, created_at
         FROM gate_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [project, asNumber(input.limit, 50)],
      );
      return { count: result.rows.length, gates: result.rows.map(serializeRow) };
    },

    async "work.reviews"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const result = await query<Record<string, unknown>>(
        `SELECT id, project_id, task_id, role, model, verdict, findings, open_blocking,
                summary, gate_run_id, iteration, tokens_input, tokens_output,
                tokens_reasoning, tokens_cache_read, tokens_cache_write, cost_usd,
                cost_source, created_at
         FROM review_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [project, asNumber(input.limit, 50)],
      );
      return { count: result.rows.length, reviews: result.rows.map(serializeRow) };
    },

    async "memory.list"(input: Record<string, unknown>) {
      const memories = await mam.store.listMemories({
        scope: asString(input.scope) || undefined,
        projectId: asString(input.project_id) || undefined,
        kind: asString(input.kind) || undefined,
        search: asString(input.search) || undefined,
        pinned: typeof input.pinned === "boolean" ? input.pinned : undefined,
        limit: asNumber(input.limit, 100),
        offset: asNumber(input.offset, 0),
      });
      return { count: memories.length, memories };
    },

    async "memory.stats"() {
      try {
        return await mam.store.memoryStats();
      } catch {
        return { available: false };
      }
    },

    async "memory.update"(input: Record<string, unknown>) {
      const id = asString(input.id);
      if (!id) throw new Error("Falta el id de la memoria.");
      const updated = await mam.store.updateMemory(id, {
        title: input.title === null ? null : asString(input.title) || undefined,
        tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
        importance:
          typeof input.importance === "number" ? Math.round(input.importance) : undefined,
        pinned: typeof input.pinned === "boolean" ? input.pinned : undefined,
      });
      if (!updated) throw new Error("La memoria no existe o no hay cambios.");
      await mam.store.audit("memory.update", id, { title: updated.title, pinned: updated.pinned });
      return { updated };
    },

    async "memory.delete"(input: Record<string, unknown>) {
      const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
      if (ids.length === 0) throw new Error("Faltan ids.");
      if (input.confirmed !== true) return { deleted: 0, requires_confirmation: true };
      const deleted = await mam.store.deleteMemories(ids);
      await mam.store.audit("memory.delete", null, { ids, deleted });
      return { deleted };
    },

    async "budgets.list"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const budgets = await mam.store.listBudgets(project);
      return { project_id: project, count: budgets.length, budgets };
    },

    async "budgets.set"(input: Record<string, unknown>) {
      if (input.confirmed !== true) return { saved: false, requires_confirmation: true };
      const project = projectId(input, deps.defaultProjectId);
      const scope = asString(input.scope) as "global" | "phase" | "task";
      if (!["global", "phase", "task"].includes(scope)) {
        throw new Error("scope debe ser global, phase o task.");
      }
      if (scope === "phase" && (!asString(input.plan_id) || typeof input.phase !== "number")) {
        throw new Error("El presupuesto de fase requiere plan_id y phase.");
      }
      if (scope === "task" && !asString(input.task_id)) {
        throw new Error("El presupuesto de tarea requiere task_id.");
      }
      const budget = await mam.store.setBudget({
        scope,
        projectId: project,
        planId: asString(input.plan_id) || null,
        phase: typeof input.phase === "number" ? Math.round(input.phase) : null,
        taskId: asString(input.task_id) || null,
        tokenBudget: typeof input.token_budget === "number" ? Math.round(input.token_budget) : null,
        maxCostUsd: typeof input.max_cost_usd === "number" ? input.max_cost_usd : null,
      });
      await mam.store.audit("budget.set", budget.key, {
        scope,
        tokenBudget: budget.tokenBudget,
        maxCostUsd: budget.maxCostUsd,
      });
      return { saved: true, budget };
    },

    async "executions.list"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const executions = await mam.store.listExecutions({
        projectId: project,
        agentId: asString(input.agent_id) || undefined,
        modelId: asString(input.model_id) || undefined,
        status: asString(input.status) || undefined,
        role: asString(input.role) || undefined,
        limit: asNumber(input.limit, 100),
        offset: asNumber(input.offset, 0),
      });
      return { project_id: project, count: executions.length, executions };
    },

    async "models.history"(input: Record<string, unknown>) {
      const role = asString(input.role);
      if (!role) throw new Error("Falta role.");
      const history = await mam.store.modelHistory(role);
      return { role, count: history.length, history };
    },

    async "agents.selection.get"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const selection = await getSelection(mam, project);
      const recommendation = recommendAgents({});
      return { project_id: project, selection, catalog: AGENT_CATALOG, recommendation };
    },

    async "agents.propose"(input: Record<string, unknown>) {
      const recommendation = recommendAgents({
        ambiguousScope: input.ambiguous_scope === true,
        crossModule: input.cross_module === true,
        phasePlan: input.phase_plan === true,
        handoff: input.handoff === true,
        research: input.research === true,
        secondOpinion: input.second_opinion === true,
      });
      return { ...recommendation, catalog: AGENT_CATALOG };
    },

    async "agents.selection.set"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const mode = asString(input.mode) as AgentMode;
      if (!["auto", "manual", "hybrid"].includes(mode)) throw new Error("mode inválido.");
      if (input.confirmed !== true && mode !== "auto") {
        return { saved: false, requires_confirmation: true };
      }
      const selected = Array.isArray(input.selected) ? input.selected.map(String) : [];
      const validation = validateSelected(selected);
      if (!validation.valid) {
        throw new Error(
          `Selección inválida. Desconocidos: ${validation.unknown.join(", ") || "ninguno"}. Faltan requeridos: ${validation.missingRequired.join(", ") || "ninguno"}.`,
        );
      }
      const recommendation = recommendAgents({});
      const recommended = Array.isArray(input.recommended)
        ? input.recommended.map(String)
        : recommendation.recommended;
      const selection = {
        projectId: project,
        mode,
        selected,
        recommended,
        approved: approvedFor(mode, selected, recommended),
        rationale: recommendation.rationale,
        updatedAt: new Date().toISOString(),
      };
      await mam.store.setAgentSelection(selection);
      let sessionApplied = false;
      const sessionID = asString(input.session_id);
      if (input.apply_session === true && sessionID) {
        await applySelectionPermissions(mam.runtime, sessionID, selection.approved);
        sessionApplied = true;
      }
      await mam.store.audit("agents.selection.set", project, {
        mode,
        selected,
        approved: selection.approved,
        sessionId: sessionApplied ? sessionID : null,
      });
      return { saved: true, selection, session_applied: sessionApplied };
    },

    async "analytics.summary"(input: Record<string, unknown>) {
      const project = projectId(input, deps.defaultProjectId);
      const days = asNumber(input.days, 30);
      const logCount = await query<{ count: number }>(
        `SELECT count(*)::int AS count FROM factory_execution_log
         WHERE project_id = $1 AND started_at > now() - ($2::int || ' days')::interval`,
        [project, days],
      );
      const useLog = Number(logCount.rows[0]?.count ?? 0) > 0;

      const byModelQuery = useLog
        ? `SELECT coalesce(provider_id || '/' || model_id, model_id, 'desconocido') AS model,
                  sum(cost_usd)::numeric AS cost,
                  sum(tokens_input)::bigint AS tokens_input,
                  sum(tokens_output)::bigint AS tokens_output,
                  count(*)::int AS runs
           FROM factory_execution_log
           WHERE project_id = $1 AND started_at > now() - ($2::int || ' days')::interval
           GROUP BY provider_id, model_id ORDER BY cost DESC NULLS LAST`
        : `SELECT model,
                  sum(cost_usd)::numeric AS cost,
                  sum(tokens_input)::bigint AS tokens_input,
                  sum(tokens_output)::bigint AS tokens_output,
                  count(*)::int AS runs
           FROM (
             SELECT model, cost_usd, tokens_input, tokens_output
             FROM subtask_runs WHERE started_at > now() - ($1::int || ' days')::interval
             UNION ALL
             SELECT model, cost_usd, tokens_input, tokens_output
             FROM review_runs WHERE created_at > now() - ($1::int || ' days')::interval
           ) runs
           GROUP BY model ORDER BY cost DESC NULLS LAST`;

      const byRoleQuery = useLog
        ? `SELECT coalesce(role, 'unknown') AS role,
                  sum(cost_usd)::numeric AS cost,
                  count(*)::int AS runs
           FROM factory_execution_log
           WHERE project_id = $1 AND started_at > now() - ($2::int || ' days')::interval
           GROUP BY role ORDER BY cost DESC NULLS LAST`
        : `SELECT role, sum(cost_usd)::numeric AS cost, count(*)::int AS runs
           FROM review_runs WHERE created_at > now() - ($1::int || ' days')::interval
           GROUP BY role ORDER BY cost DESC NULLS LAST`;

      const byDayQuery = useLog
        ? `SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day,
                  sum(cost_usd)::numeric AS cost,
                  count(*)::int AS runs
           FROM factory_execution_log
           WHERE project_id = $1 AND started_at > now() - ($2::int || ' days')::interval
           GROUP BY date_trunc('day', started_at) ORDER BY day`
        : `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(cost)::numeric AS cost, sum(runs)::int AS runs
           FROM (
             SELECT date_trunc('day', started_at) AS day, cost_usd AS cost, 1 AS runs
             FROM subtask_runs WHERE started_at > now() - ($1::int || ' days')::interval
             UNION ALL
             SELECT date_trunc('day', created_at) AS day, cost_usd AS cost, 1 AS runs
             FROM review_runs WHERE created_at > now() - ($1::int || ' days')::interval
           ) daily GROUP BY day ORDER BY day`;

      const [byModel, byRole, byDay, totals] = await Promise.all([
        query<Record<string, unknown>>(byModelQuery, useLog ? [project, days] : [days]),
        query<Record<string, unknown>>(byRoleQuery, useLog ? [project, days] : [days]),
        query<Record<string, unknown>>(byDayQuery, useLog ? [project, days] : [days]),
        query<Record<string, unknown>>(
          `SELECT
             (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS tasks,
             (SELECT count(*)::int FROM plans WHERE project_id = $1) AS plans,
             (SELECT count(*)::int FROM gate_runs WHERE project_id = $1) AS gates,
             (SELECT count(*)::int FROM review_runs WHERE project_id = $1) AS reviews,
             (SELECT count(*)::int FROM factory_execution_log
              WHERE project_id = $1 AND started_at > now() - ($2::int || ' days')::interval) AS execution_runs,
             (SELECT coalesce(sum(cost_usd), 0)::numeric FROM factory_execution_log
              WHERE project_id = $1 AND started_at > now() - ($2::int || ' days')::interval) AS execution_cost,
             (SELECT coalesce(sum(cost_usd), 0)::numeric FROM subtask_runs
              WHERE started_at > now() - ($2::int || ' days')::interval) AS subtask_cost,
             (SELECT coalesce(sum(cost_usd), 0)::numeric FROM review_runs
              WHERE created_at > now() - ($2::int || ' days')::interval) AS review_cost`,
          [project, days],
        ),
      ]);
      return {
        project_id: project,
        days,
        source: useLog ? "execution_log" : "subtask_review",
        by_model: byModel.rows.map(serializeRow),
        by_role: byRole.rows.map(serializeRow),
        by_day: byDay.rows.map(serializeRow),
        totals: serializeRow(totals.rows[0] ?? {}),
      };
    },
  };
}
