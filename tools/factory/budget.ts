/**
 * Presupuestos por ejecución.
 *
 * La reserva es atómica en PostgreSQL. Si una ola paralela no cabe en el saldo,
 * el lanzamiento falla antes de crear la sesión. Al terminar se liquida el uso
 * real; si el proceso muere, queda una reserva abierta y una ejecución
 * `running` para que `factory_doctor`/`plan_resume` la detecten.
 */

import type { BudgetReservationResult, MamStore } from "./mam-db.js";
import type { MamRuntime } from "./mam.js";

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

export function estimateReserveTokens(
  difficulty: string,
  maxTokens: number | null | undefined,
): number {
  if (typeof maxTokens === "number" && maxTokens > 0) return Math.round(maxTokens);
  if (difficulty === "easy") return 50_000;
  if (difficulty === "hard") return 300_000;
  return 150_000;
}

export async function estimateReserveCost(
  store: MamStore,
  providerId: string,
  modelId: string,
  tokens: number,
  maxCostUsd: number | null | undefined,
): Promise<number> {
  if (typeof maxCostUsd === "number" && maxCostUsd >= 0) return maxCostUsd;
  const price = await store.modelPrice(providerId, modelId);
  if (!price) return 0;
  const input = price.input ?? 0;
  const output = price.output ?? 0;
  // Mezcla conservadora: 70% entrada y 30% salida.
  return ((input * 0.7 + output * 0.3) * tokens) / 1_000_000;
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
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
}): { tokens: number; costUsd: number } {
  const tokens =
    usage.tokens.input +
    usage.tokens.output +
    usage.tokens.reasoning +
    usage.tokens.cacheRead +
    usage.tokens.cacheWrite;
  return { tokens, costUsd: usage.costUsd };
}

export function toolVersions(runtime: any): Record<string, unknown> {
  return {
    node: process.version,
    opencode: runtime?.app?.version ?? null,
    platform: process.platform,
  };
}
