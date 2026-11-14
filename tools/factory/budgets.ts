/**
 * Tools de presupuesto y registro de ejecución.
 *
 * La reserva real vive en `subtask_run`/`review_run`; estas tools solo
 * configuran límites y consultan evidencia. No ejecutan shell.
 */

import type { MamRuntime } from "./mam.js";
import { fail, ok, type ToolDef } from "./types.js";

export interface BudgetToolsDeps {
  mam: MamRuntime;
  resolveProject: (sessionID: string) => Promise<{ projectId: string }>;
}

export function createBudgetTools(deps: BudgetToolsDeps): ToolDef[] {
  return [
    {
      name: "budget_list",
      description: "Lista los presupuestos global, de fase y de tarea del proyecto.",
      input: {
        type: "object",
        properties: { project_id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          const project = await deps.resolveProject(String(context.sessionID));
          const projectId = String(input.project_id ?? project.projectId);
          const budgets = await deps.mam.store.listBudgets(projectId);
          return ok({ project_id: projectId, count: budgets.length, budgets });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "budget_set",
      description:
        "Fija el límite de tokens y/o coste de un presupuesto global, de fase o de tarea. Requiere confirmed=true.",
      input: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "phase", "task"] },
          project_id: { type: "string" },
          plan_id: { type: "string" },
          phase: { type: "integer", minimum: 0 },
          task_id: { type: "string" },
          max_tokens: { type: "integer", minimum: 0 },
          max_cost_usd: { type: "number", minimum: 0 },
          confirmed: { type: "boolean", default: false },
        },
        required: ["scope", "confirmed"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          if (input.confirmed !== true) {
            return ok({ saved: false, requires_confirmation: true });
          }
          const project = await deps.resolveProject(String(context.sessionID));
          const projectId = String(input.project_id ?? project.projectId);
          const scope = String(input.scope) as "global" | "phase" | "task";
          if (scope !== "global" && scope !== "phase" && scope !== "task") {
            return fail("scope debe ser global, phase o task.");
          }
          if (scope === "phase" && (!input.plan_id || typeof input.phase !== "number")) {
            return fail("El presupuesto de fase requiere plan_id y phase.");
          }
          if (scope === "task" && typeof input.task_id !== "string") {
            return fail("El presupuesto de tarea requiere task_id.");
          }
          const budget = await deps.mam.store.setBudget({
            scope,
            projectId,
            planId: typeof input.plan_id === "string" ? input.plan_id : null,
            phase: typeof input.phase === "number" ? input.phase : null,
            taskId: typeof input.task_id === "string" ? input.task_id : null,
            maxTokens: typeof input.max_tokens === "number" ? Math.round(input.max_tokens) : null,
            maxCostUsd: typeof input.max_cost_usd === "number" ? input.max_cost_usd : null,
          });
          await deps.mam.store.audit("budget.set", budget.key, {
            scope,
            maxTokens: budget.maxTokens,
            maxCostUsd: budget.maxCostUsd,
          });
          return ok({ saved: true, budget });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "executions_list",
      description:
        "Lista ejecuciones reales por agente/modelo con tokens, coste, estado, intento y motivo de selección. Alimenta la evaluación de modelos.",
      input: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          agent_id: { type: "string" },
          model_id: { type: "string" },
          status: { type: "string" },
          role: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          const project = await deps.resolveProject(String(context.sessionID));
          const executions = await deps.mam.store.listExecutions({
            projectId: String(input.project_id ?? project.projectId),
            agentId: typeof input.agent_id === "string" ? input.agent_id : undefined,
            modelId: typeof input.model_id === "string" ? input.model_id : undefined,
            status: typeof input.status === "string" ? input.status : undefined,
            role: typeof input.role === "string" ? input.role : undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined,
            offset: typeof input.offset === "number" ? input.offset : undefined,
          });
          return ok({ count: executions.length, executions });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "model_history",
      description:
        "Devuelve la tasa de éxito, coste medio y tokens medios por modelo para un rol, a partir del execution log.",
      input: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["implementer", "security", "code", "qa", "plan", "orchestration"] },
        },
        required: ["role"],
        additionalProperties: false,
      },
      async execute(input) {
        try {
          const role = String(input.role ?? "").trim();
          if (!role) return fail("Falta role.");
          const history = await deps.mam.store.modelHistory(role);
          return ok({ role, count: history.length, history });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}
