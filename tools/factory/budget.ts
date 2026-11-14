/**
 * Presupuestos por ejecución.
 *
 * Unidad: coste cuando el modelo tiene precio versionado; tokens ponderados
 * cuando no lo tiene (Ollama, tarifa plana). La reserva es atómica y se
 * liquida con el uso real. La calibración usa el percentil 90 histórico del
 * rol+dificultad cuando hay suficientes ejecuciones.
 */

import type { BudgetReservationResult, MamStore } from "./mam-db.js";
import type { MamRuntime } from "./mam.js";
import type { TokenUsage } from "./db.js";
import { catalogCostUsd, weightedTokens } from "./usage.js";

export interface BudgetScopeInput {
  projectId: string;
  planId?: string | null;
  phase?: number | null;
  taskId?: string | null;
}

export interface ReserveInput extends BudgetScopeInput {
  executionId: string;
  tokens: number;
  costUsd: number;
}

export type BudgetUnit = "cost" | "weighted_tokens";
export type ReservationSource = "assignment" | "history_p90" | "default";

export interface ReservePlan {
  tokens: number;
  costUsd: number;
  unit: BudgetUnit;
  source: ReservationSource;
  historyRuns: number;
}

export interface CalibrateInput {
  role: string;
  difficulty: string;
  providerId: string;
  modelId: string;
  assignmentTokenBudget?: number | null;
  assignmentMaxCostUsd?: number | null;
}

function defaultRawTokens(difficulty: string): number {
  if (difficulty === "easy") return 100_000;
  if (difficulty === "hard") return 600_000;
  return 300_000;
}

function defaultWeightedTokens(difficulty: string): number {
  if (difficulty === "easy") return 100_000;
  if (difficulty === "hard") return 600_000;
  return 300_000;
}

export async function calibrateReservePlan(
  store: MamStore,
  input: CalibrateInput,
): Promise<ReservePlan> {
  const price = await store.modelPrice(input.providerId, input.modelId);
  const history = await store.executionPercentile(input.role, input.difficulty, 0.9);
  const hasHistory = history.runs >= 5 && (history.p90WeightedTokens ?? 0) > 0;

  if (price) {
    const rawTokens =
      typeof input.assignmentTokenBudget === "number" && input.assignmentTokenBudget > 0
        ? input.assignmentTokenBudget
        : defaultRawTokens(input.difficulty);
    const synthetic: TokenUsage = {
      input: Math.round(rawTokens * 0.7),
      output: Math.round(rawTokens * 0.3),
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const estimatedCost = catalogCostUsd(synthetic, {
      input: price.input ?? 0,
      output: price.output ?? 0,
      cacheRead: price.cacheRead ?? 0,
      cacheWrite: price.cacheWrite ?? 0,
      basis: "tabla versionada",
    });
    const costUsd =
      typeof input.assignmentMaxCostUsd === "number" && input.assignmentMaxCostUsd >= 0
        ? input.assignmentMaxCostUsd
        : hasHistory && (history.p90CostUsd ?? 0) > 0
          ? history.p90CostUsd!
          : estimatedCost;
    return {
      tokens:
        typeof input.assignmentTokenBudget === "number" && input.assignmentTokenBudget > 0
          ? input.assignmentTokenBudget
          : 0,
      costUsd,
      unit: "cost",
      source:
        typeof input.assignmentTokenBudget === "number" ||
        typeof input.assignmentMaxCostUsd === "number"
          ? "assignment"
          : hasHistory
            ? "history_p90"
            : "default",
      historyRuns: history.runs,
    };
  }

  const tokens =
    typeof input.assignmentTokenBudget === "number" && input.assignmentTokenBudget > 0
      ? input.assignmentTokenBudget
      : hasHistory
        ? Math.round(history.p90WeightedTokens ?? 0)
        : defaultWeightedTokens(input.difficulty);
  return {
    tokens,
    costUsd: 0,
    unit: "weighted_tokens",
    source:
      typeof input.assignmentTokenBudget === "number" && input.assignmentTokenBudget > 0
        ? "assignment"
        : hasHistory
          ? "history_p90"
          : "default",
    historyRuns: history.runs,
  };
}

export function budgetKeys(input: BudgetScopeInput): string[] {
  const keys = [`global:${input.projectId}`];
  if (input.planId && typeof input.phase === "number") {
    keys.push(`phase:${input.projectId}:${input.planId}:${input.phase}`);
  }
  if (input.taskId) {
    keys.push(`task:${input.projectId}:${input.taskId}`);
  }
  return keys;
}

export async function ensureBudgets(mam: MamRuntime, input: BudgetScopeInput): Promise<string[]> {
  const keys: string[] = [];
  const globalBudget = await mam.store.ensureBudget({
    scope: "global",
    projectId: input.projectId,
  });
  keys.push(globalBudget.key);
  if (input.planId && typeof input.phase === "number") {
    const phaseBudget = await mam.store.ensureBudget({
      scope: "phase",
      projectId: input.projectId,
      planId: input.planId,
      phase: input.phase,
    });
    keys.push(phaseBudget.key);
  }
  if (input.taskId) {
    const taskBudget = await mam.store.ensureBudget({
      scope: "task",
      projectId: input.projectId,
      taskId: input.taskId,
    });
    keys.push(taskBudget.key);
  }
  return keys;
}

export async function reserveExecution(
  mam: MamRuntime,
  input: ReserveInput,
): Promise<BudgetReservationResult> {
  const keys = await ensureBudgets(mam, input);
  return mam.store.reserveBudget({
    executionId: input.executionId,
    keys,
    tokens: input.tokens,
    costUsd: input.costUsd,
  });
}

export async function budgetWarnings(
  mam: MamRuntime,
  input: BudgetScopeInput,
  unit: BudgetUnit,
): Promise<string[]> {
  const keys = budgetKeys(input);
  const budgets = await mam.store.budgetUsage(keys);
  const warnings: string[] = [];
  for (const budget of budgets) {
    const max = unit === "cost" ? budget.maxCostUsd : budget.tokenBudget;
    if (!max || max <= 0) continue;
    const used =
      unit === "cost"
        ? budget.spentCostUsd + budget.reservedCostUsd
        : budget.spentWeightedTokens + budget.reservedWeightedTokens;
    const ratio = used / max;
    if (ratio >= 0.8) {
      warnings.push(
        `${budget.key}: ${Math.round(ratio * 100)}% usado (${unit === "cost" ? `$${used.toFixed(4)}` : `${Math.round(used)} tokens ponderados`} de ${unit === "cost" ? `$${max}` : max}).`,
      );
    }
  }
  return warnings;
}

export async function settleExecution(
  mam: MamRuntime,
  executionId: string,
  tokens: number,
  costUsd: number,
): Promise<void> {
  await mam.store.settleBudget(executionId, tokens, costUsd);
}

export async function releaseExecution(mam: MamRuntime, executionId: string): Promise<void> {
  await mam.store.releaseBudget(executionId);
}

export function usageTotals(usage: {
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  costUsd: number;
}): { tokens: number; weightedTokens: number; costUsd: number } {
  const tokens =
    usage.tokens.input +
    usage.tokens.output +
    usage.tokens.reasoning +
    usage.tokens.cacheRead +
    usage.tokens.cacheWrite;
  return {
    tokens,
    weightedTokens: weightedTokens(usage.tokens),
    costUsd: usage.costUsd,
  };
}

export function toolVersions(runtime: any): Record<string, unknown> {
  return {
    node: process.version,
    opencode: runtime?.app?.version ?? null,
    platform: process.platform,
  };
}
