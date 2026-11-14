/**
 * Selección determinística de modelo por rol.
 *
 * Orden de filtros: política → factibilidad (catálogo/tools/contexto) →
 * historial → modo. El LLM solo aporta la clasificación de dificultad de la
 * tarea; la decisión de modelo vive en código.
 */

import type { ExecutionProfileWithAssignments, ModelRecord, ProfileAssignmentRecord } from "./mam-db.js";
import type { MamRuntime } from "./mam.js";
import type { PlanTaskRecord } from "./plan-db.js";
import { isSensitiveTask } from "./paths.js";
import { modelFamily, routeReview, sameFamily, type ReviewRole } from "./routing.js";

export type WorkMode = "auto" | "manual" | "hybrid";
export type SelectionRole = "implementer" | "security" | "code" | "qa";

export interface ModelSelectionInput {
  mam: MamRuntime;
  projectId: string;
  planId: string;
  task: PlanTaskRecord;
  role: SelectionRole;
  mode: WorkMode;
  agentId: string;
  authorModel?: string;
  confirmed?: boolean;
  attempt?: number;
}

export interface ResolvedProfile {
  profile: ExecutionProfileWithAssignments | null;
  assignment: ProfileAssignmentRecord | null;
  policy: Record<string, unknown>;
}

export interface ModelSelection {
  model: string;
  providerId: string;
  modelId: string;
  reason: string;
  requiresApproval: boolean;
  profileId: string | null;
  assignment: ProfileAssignmentRecord | null;
  policy: Record<string, unknown>;
  maxTokens: number | null;
  maxCostUsd: number | null;
}

const REVIEW_ROLE: Record<Exclude<SelectionRole, "implementer">, ReviewRole> = {
  security: "security",
  code: "code",
  qa: "qa",
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function priceOf(model: ModelRecord): number {
  return (model.costInput ?? 0) + (model.costOutput ?? 0);
}

function modelRef(model: ModelRecord): string {
  return `${model.providerId}/${model.modelId}`;
}

function policyAllows(model: ModelRecord, policy: Record<string, unknown>): boolean {
  const allowedProviders = asStringArray(policy.allowedProviders);
  const allowedModels = asStringArray(policy.allowedModels);
  const prohibitedModels = asStringArray(policy.prohibitedModels);
  const requireTools = policy.requireTools !== false;
  const minContext = typeof policy.minContext === "number" ? policy.minContext : 0;
  if (allowedProviders.length > 0 && !allowedProviders.includes(model.providerId)) return false;
  if (allowedModels.length > 0 && !allowedModels.includes(modelRef(model))) return false;
  if (prohibitedModels.includes(modelRef(model))) return false;
  if (requireTools && model.capabilities.tools !== true) return false;
  if (minContext > 0 && (model.contextLimit ?? 0) < minContext) return false;
  return true;
}

export async function activeMode(mam: MamRuntime): Promise<WorkMode> {
  const appliedId = await mam.store.getAppliedProfile(mam.location);
  const profile = appliedId
    ? await mam.store.getProfile(appliedId)
    : await mam.store.getDefaultProfile();
  const mode = profile?.mode;
  return mode === "auto" || mode === "manual" || mode === "hybrid" ? mode : "hybrid";
}

export async function resolveProfile(mam: MamRuntime): Promise<ResolvedProfile> {
  const appliedId = await mam.store.getAppliedProfile(mam.location);
  const profile = appliedId
    ? await mam.store.getProfile(appliedId)
    : await mam.store.getDefaultProfile();
  return {
    profile,
    assignment: null,
    policy: (profile?.policy ?? {}) as Record<string, unknown>,
  };
}

function findAssignment(
  profile: ExecutionProfileWithAssignments | null,
  agentId: string,
): ProfileAssignmentRecord | null {
  return profile?.assignments.find((assignment) => assignment.agentId === agentId) ?? null;
}

function difficultyCostWeight(difficulty: string): number {
  if (difficulty === "easy") return 0.5;
  if (difficulty === "hard") return 0.05;
  return 0.25;
}

export async function selectModel(input: ModelSelectionInput): Promise<ModelSelection> {
  const resolved = await resolveProfile(input.mam);
  const assignment = findAssignment(resolved.profile, input.agentId);
  const policy = resolved.policy;

  const models = (await input.mam.store.listModels({ limit: 2_000 })).filter(
    (model) =>
      model.enabled &&
      model.authorized &&
      !model.prohibited &&
      model.status === "active" &&
      policyAllows(model, policy),
  );

  const reviewRole = input.role === "implementer" ? null : REVIEW_ROLE[input.role];
  const candidates = models.filter((model) => {
    if (!reviewRole) return true;
    if (!input.authorModel) return true;
    return !sameFamily(input.authorModel, modelRef(model));
  });

  const byRef = new Map(candidates.map((model) => [modelRef(model), model]));
  const assignmentModel = assignment
    ? byRef.get(`${assignment.providerId}/${assignment.modelId}`) ?? null
    : null;

  if (input.mode === "manual") {
    if (!assignment) {
      throw new Error(
        `Modo manual: no hay modelo asignado para ${input.agentId} en el perfil aplicado. Configúralo en Models.`,
      );
    }
    if (!assignmentModel) {
      throw new Error(
        `Modo manual: el modelo ${assignment.providerId}/${assignment.modelId} de ${input.agentId} no está disponible o no cumple la política.`,
      );
    }
    return {
      model: modelRef(assignmentModel),
      providerId: assignmentModel.providerId,
      modelId: assignmentModel.modelId,
      reason: "manual: modelo bloqueado por perfil",
      requiresApproval: false,
      profileId: resolved.profile?.id ?? null,
      assignment,
      policy,
      maxTokens: assignment.maxTokens,
      maxCostUsd: assignment.maxCostUsd,
    };
  }

  if (candidates.length === 0) {
    throw new Error(
      `No hay modelos factibles para ${input.agentId} con la política actual${reviewRole ? " y la regla de familia independiente" : ""}.`,
    );
  }

  const history = await input.mam.store.modelHistory(input.role);
  const historyByRef = new Map(history.map((item) => [`${item.providerId}/${item.modelId}`, item]));
  const maxCost = Math.max(...candidates.map((model) => priceOf(model)), 0);
  const costWeight = difficultyCostWeight(input.task.difficulty);

  const scored = candidates.map((model) => {
    const ref = modelRef(model);
    const item = historyByRef.get(ref);
    const successRate = item && item.runs >= 3 ? item.successes / item.runs : 0.5;
    const costScore = maxCost > 0 ? 1 - Math.min(priceOf(model) / maxCost, 1) : 0.5;
    const assignmentBonus = assignment && ref === `${assignment.providerId}/${assignment.modelId}` ? 0.15 : 0;
    const score = successRate * 0.7 + costScore * costWeight + assignmentBonus;
    return { model, ref, score, successRate, costScore };
  });
  scored.sort((left, right) => right.score - left.score || priceOf(left.model) - priceOf(right.model));
  const chosen = scored[0]!;

  const assignmentRef = assignment ? `${assignment.providerId}/${assignment.modelId}` : null;
  const reason =
    chosen.ref === assignmentRef
      ? "auto: preferencia del perfil y mejor score (éxito/coste)"
      : `auto: mejor score (éxito/coste) sobre ${candidates.length} candidatos`;

  let requiresApproval = false;
  if (input.mode === "hybrid") {
    const sensitive = isSensitiveTask(input.task);
    const retries = (input.attempt ?? input.task.attempts ?? 0) >= 2;
    const assignmentPrice = assignmentModel ? priceOf(assignmentModel) : null;
    const chosenPrice = priceOf(chosen.model);
    const moreExpensive =
      assignmentPrice !== null && assignmentPrice > 0 && chosenPrice > assignmentPrice * 1.5;
    requiresApproval = sensitive || retries || moreExpensive;
    if (requiresApproval && input.confirmed !== true) {
      return {
        model: chosen.ref,
        providerId: chosen.model.providerId,
        modelId: chosen.model.modelId,
        reason: `${reason}; híbrido requiere aprobación (${
          sensitive ? "tarea sensible" : retries ? "reintentos" : "modelo más caro"
        })`,
        requiresApproval: true,
        profileId: resolved.profile?.id ?? null,
        assignment,
        policy,
        maxTokens: assignment?.maxTokens ?? null,
        maxCostUsd: assignment?.maxCostUsd ?? null,
      };
    }
  }

  return {
    model: chosen.ref,
    providerId: chosen.model.providerId,
    modelId: chosen.model.modelId,
    reason,
    requiresApproval,
    profileId: resolved.profile?.id ?? null,
    assignment,
    policy,
    maxTokens: assignment?.maxTokens ?? null,
    maxCostUsd: assignment?.maxCostUsd ?? null,
  };
}

export async function defaultReviewModel(
  input: Omit<ModelSelectionInput, "role"> & { role: Exclude<SelectionRole, "implementer"> },
): Promise<ModelSelection> {
  return selectModel({
    ...input,
    role: input.role,
  });
}

export function fallbackModelForRole(role: SelectionRole, authorModel?: string): string {
  if (role === "implementer") return "opencode-go/glm-5.3-flash";
  return routeReview(authorModel ?? "opencode-go/deepseek-v4.1-flash", REVIEW_ROLE[role]);
}

export function familyOf(model: string): string {
  return modelFamily(model);
}
