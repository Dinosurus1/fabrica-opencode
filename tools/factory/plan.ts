/**
 * Tools de planificación por fases.
 *
 * Qué hacen: crean y actualizan el plan, validan el DAG y muestran su estado.
 * No crean worktrees ni lanzan subagentes; eso vive en `subtasks.ts` y `phase.ts`.
 */

import { randomUUID } from "node:crypto";
import type { FactoryDb, ProjectRef } from "./db.js";
import type {
  Autonomy,
  PlanRecord,
  PlanStore,
  PlanTaskRecord,
  PlanTaskStatus,
  PlanStatus,
} from "./plan-db.js";
import { defaultAssignee, defaultImplementerModel, MODELS } from "./routing.js";
import { findingText, isBlockingSeverity, normalizeSeverity, summarizeFindings } from "./review-severity.js";
import { validatePlan, nextWave, type PlanTaskLike } from "./scheduler.js";
import { isSafeBranchName, isSharedTask, isSensitiveTask, worktreeRoot } from "./paths.js";
import { fail, looksLikeSecret, ok, type ToolDef } from "./types.js";

export interface PlanToolsDeps {
  db: FactoryDb;
  planStore: PlanStore;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const ASSIGNEES = ["orchestrator", "implementer"] as const;
const AUTONOMIES = ["supervised", "semi_autonomous", "autonomous"] as const;
const PLAN_STATUSES = [
  "draft",
  "review_pending",
  "validated",
  "approved",
  "executing",
  "paused",
  "completed",
  "cancelled",
] as const;
const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "review",
  "blocked",
  "merged",
  "done",
  "failed",
  "escalated",
  "cancelled",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function asDifficulty(value: unknown): "easy" | "medium" | "hard" | null {
  return typeof value === "string" && (DIFFICULTIES as readonly string[]).includes(value)
    ? (value as "easy" | "medium" | "hard")
    : null;
}

function asAssignee(value: unknown): "orchestrator" | "implementer" | null {
  return typeof value === "string" && (ASSIGNEES as readonly string[]).includes(value)
    ? (value as "orchestrator" | "implementer")
    : null;
}

function asAutonomy(value: unknown): Autonomy | null {
  return typeof value === "string" && (AUTONOMIES as readonly string[]).includes(value)
    ? (value as Autonomy)
    : null;
}

function asPlanStatus(value: unknown): PlanStatus | null {
  return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value)
    ? (value as PlanStatus)
    : null;
}

function asTaskStatus(value: unknown): PlanTaskStatus | null {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
    ? (value as PlanTaskStatus)
    : null;
}

function toPlanTaskLike(task: PlanTaskRecord): PlanTaskLike {
  return {
    id: task.id,
    phase: task.phase,
    phaseName: task.phaseName,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    difficulty: task.difficulty,
    difficultyReason: task.difficultyReason,
    assignee: task.assignee,
    model: task.model,
    filesOwned: task.filesOwned,
    riskFlags: task.riskFlags,
    parallelizable: task.parallelizable,
    dependsOn: task.dependsOn,
    status: task.status,
  };
}

function projectTaskInput(raw: unknown, index: number): {
  key: string;
  phase: number;
  phaseName: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string;
  difficulty: "easy" | "medium" | "hard";
  difficultyReason: string;
  assignee: "orchestrator" | "implementer";
  model: string;
  filesOwned: string[];
  riskFlags: string[];
  parallelizable: boolean;
  dependsOnKeys: string[];
} | null {
  const input = asRecord(raw);
  const key = asString(input.key) || `task-${index + 1}`;
  const phase = typeof input.phase === "number" ? Math.round(input.phase) : -1;
  const title = asString(input.title);
  const description = asString(input.description);
  const acceptance = asString(input.acceptance_criteria);
  const difficulty = asDifficulty(input.difficulty);
  const filesOwned = asStringArray(input.files_owned);
  if (!title || !description || !acceptance || !difficulty || phase < 0 || filesOwned.length === 0) return null;

  const riskFlags = asStringArray(input.risk_flags);
  const sensitive = isSensitiveTask({ title, description, filesOwned, riskFlags });
  const explicitAssignee = asAssignee(input.assignee);
  const assignee = explicitAssignee ?? defaultAssignee(difficulty);
  const model = asString(input.model) || (assignee === "orchestrator" ? MODELS.orchestrator : defaultImplementerModel(difficulty));
  const shared = isSharedTask(filesOwned);
  const parallelizable =
    typeof input.parallelizable === "boolean" ? input.parallelizable : !shared;

  return {
    key,
    phase,
    phaseName: asString(input.phase_name) || null,
    title,
    description,
    acceptanceCriteria: acceptance,
    difficulty,
    difficultyReason: asString(input.difficulty_reason) || "Sin justificación explícita.",
    assignee,
    model,
    filesOwned,
    riskFlags: sensitive && !riskFlags.includes("sensitive") ? [...riskFlags, "sensitive"] : riskFlags,
    parallelizable,
    dependsOnKeys: asStringArray(input.depends_on),
  };
}

function parseReviewDecisions(value: unknown): Array<{
  finding: string;
  decision: "accepted" | "refuted";
  evidence: string;
  at: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = asRecord(raw);
    return {
      finding: asString(item.finding),
      decision: item.decision === "refuted" ? "refuted" : "accepted",
      evidence: asString(item.evidence),
      at: new Date().toISOString(),
    };
  });
}

function normalizeDecisionText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function decisionMatchesFinding(decision: string, finding: unknown): boolean {
  const chosen = normalizeDecisionText(decision);
  const text = normalizeDecisionText(findingText(finding));
  if (!chosen || !text) return false;
  if (chosen === text) return true;
  // Permitir submatch solo con texto suficientemente específico.
  return Math.min(chosen.length, text.length) >= 20 && (text.includes(chosen) || chosen.includes(text));
}

function decisionSeverity(decision: string, findings: unknown[]): "CRITICO" | "ALTO" | "MEDIO" | "BAJO" {
  const match = findings.find((finding) => decisionMatchesFinding(decision, finding));
  if (!match || typeof match !== "object") return "ALTO";
  return normalizeSeverity((match as Record<string, unknown>).severity);
}

function planSummary(plan: PlanRecord, tasks: PlanTaskRecord[]) {
  const counts: Record<string, number> = {};
  const byPhase: Record<string, { total: number; done: number; active: number; blocked: number }> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    const key = String(task.phase);
    const bucket = byPhase[key] ?? { total: 0, done: 0, active: 0, blocked: 0 };
    bucket.total += 1;
    if (["done", "merged"].includes(task.status)) bucket.done += 1;
    if (["running", "review"].includes(task.status)) bucket.active += 1;
    if (["blocked", "failed", "escalated"].includes(task.status)) bucket.blocked += 1;
    byPhase[key] = bucket;
  }
  return { counts, byPhase };
}

export function createPlanTools(deps: PlanToolsDeps): ToolDef[] {
  return [
    {
      name: "plan_create",
      description:
        "Crea un plan por fases con tareas, dependencias, dificultad, archivos y criterios. Falla si el plan no es válido.",
      input: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 3, maxLength: 200 },
          autonomy: { type: "string", enum: AUTONOMIES, default: "supervised" },
          confirmed: { type: "boolean", description: "Obligatorio para autonomía total." },
          max_concurrency: { type: "integer", minimum: 1, maximum: 8, default: 3 },
          source_documents: { type: "array", items: { type: "string" } },
          metadata: { type: "object", additionalProperties: true },
          tasks: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                key: { type: "string", minLength: 1, maxLength: 80 },
                phase: { type: "integer", minimum: 0 },
                phase_name: { type: "string", maxLength: 120 },
                title: { type: "string", minLength: 3, maxLength: 200 },
                description: { type: "string", minLength: 1, maxLength: 8_000 },
                acceptance_criteria: { type: "string", minLength: 1, maxLength: 4_000 },
                difficulty: { type: "string", enum: DIFFICULTIES },
                difficulty_reason: { type: "string", maxLength: 1_000 },
                assignee: { type: "string", enum: ASSIGNEES },
                model: { type: "string", maxLength: 160 },
                files_owned: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
                risk_flags: { type: "array", items: { type: "string" } },
                parallelizable: { type: "boolean" },
                depends_on: { type: "array", items: { type: "string" } },
              },
              required: ["key", "phase", "title", "description", "acceptance_criteria", "difficulty", "files_owned"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "tasks"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const profile = await deps.db.getProfile(project.projectId);
        if (!profile) return fail("No hay perfil del proyecto. Ejecuta onboarding y `project_profile_set` primero.");

        const title = asString(input.title);
        if (title.length < 3) return fail("El título del plan debe tener al menos 3 caracteres.");
        const autonomy = asAutonomy(input.autonomy) ?? "supervised";
        const maxConcurrency = typeof input.max_concurrency === "number" ? Math.round(input.max_concurrency) : 3;
        if (maxConcurrency < 1 || maxConcurrency > 8) return fail("max_concurrency debe estar entre 1 y 8.");
        if (autonomy === "autonomous" && input.confirmed !== true) {
          return fail("Crear un plan con autonomía total requiere confirmed=true.");
        }
        const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
        if (rawTasks.length === 0) return fail("Incluye al menos una tarea.");
        if (looksLikeSecret(JSON.stringify({ title, tasks: rawTasks }))) {
          return fail("El plan parece contener un secreto. No se guardó.");
        }

        const normalized = rawTasks.map((raw, index) => projectTaskInput(raw, index));
        if (normalized.some((task) => task === null)) {
          return fail("Cada tarea necesita key, phase, title, description, acceptance_criteria, difficulty y files_owned.");
        }
        const tasks = normalized as NonNullable<(typeof normalized)[number]>[];
        const keys = new Set<string>();
        for (const task of tasks) {
          if (keys.has(task.key)) return fail(`Key duplicada en tareas: ${task.key}.`);
          keys.add(task.key);
        }
        for (const task of tasks) {
          for (const dependency of task.dependsOnKeys) {
            if (!keys.has(dependency)) return fail(`La tarea ${task.key} depende de "${dependency}", que no existe.`);
          }
        }

        const idByKey = new Map(tasks.map((task) => [task.key, randomUUID()]));
        const planTasks: PlanTaskLike[] = tasks.map((task) => ({
          id: idByKey.get(task.key)!,
          phase: task.phase,
          phaseName: task.phaseName,
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          difficulty: task.difficulty,
          difficultyReason: task.difficultyReason,
          assignee: task.assignee,
          model: task.model,
          filesOwned: task.filesOwned,
          riskFlags: task.riskFlags,
          parallelizable: task.parallelizable,
          dependsOn: task.dependsOnKeys.map((key) => idByKey.get(key)!),
          status: "pending",
        }));
        const validation = validatePlan(planTasks);
        if (!validation.ok) {
          return ok({
            created: false,
            validation,
            message: "El plan no se creó porque la validación determinista falló.",
          });
        }

        const plan = await deps.planStore.createPlan({
          projectId: project.projectId,
          projectPath: project.directory,
          title,
          autonomy,
          maxConcurrency,
          sourceDocuments: asStringArray(input.source_documents),
          metadata: asRecord(input.metadata),
        });
        try {
          for (let index = 0; index < tasks.length; index += 1) {
            const task = tasks[index]!;
            const planTask = planTasks[index]!;
            await deps.planStore.createPlanTask({
              id: planTask.id,
              planId: plan.id,
              phase: task.phase,
              phaseName: task.phaseName,
              orderIndex: index,
              title: task.title,
              description: task.description,
              acceptanceCriteria: task.acceptanceCriteria,
              difficulty: task.difficulty,
              difficultyReason: task.difficultyReason,
              assignee: task.assignee,
              model: task.model,
              filesOwned: task.filesOwned,
              riskFlags: task.riskFlags,
              parallelizable: task.parallelizable,
              dependsOn: planTask.dependsOn,
            });
          }
        } catch (error) {
          const reverted = await deps.planStore.deletePlan(project.projectId, plan.id).catch(() => false);
          return fail(
            `El plan no se creó; falló una tarea y ${reverted ? "se revirtió el plan" : "no se pudo revertir el plan"}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const createdTasks = await deps.planStore.listPlanTasks(plan.id);
        const updatedPlan = await deps.planStore.updatePlan(project.projectId, plan.id, {
          validation: validation as unknown as Record<string, unknown>,
        });
        return ok({
          created: true,
          plan: updatedPlan ?? plan,
          tasks: createdTasks,
          validation,
          warnings: validation.warnings,
        });
      },
    },
    {
      name: "plan_update",
      description:
        "Actualiza un plan: metadatos, autonomía, concurrencia, tareas, decisiones de revisión o estado. Aprobar exige confirmed=true.",
      input: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
          title: { type: "string", minLength: 3, maxLength: 200 },
          status: { type: "string", enum: PLAN_STATUSES },
          autonomy: { type: "string", enum: AUTONOMIES },
          max_concurrency: { type: "integer", minimum: 1, maximum: 8 },
          confirmed: { type: "boolean" },
          exhausted_decision: {
            type: "string",
            enum: ["approve_with_waiver", "fix_and_revalidate", "cancel"],
            description: "Decisión humana cuando plan_review devuelve exhausted.",
          },
          waiver: { type: "string", maxLength: 4_000 },
          review_decisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                finding: { type: "string", minLength: 1, maxLength: 2_000 },
                decision: { type: "string", enum: ["accepted", "refuted"] },
                evidence: { type: "string", minLength: 1, maxLength: 4_000 },
              },
              required: ["finding", "decision", "evidence"],
              additionalProperties: false,
            },
          },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                task_id: { type: "string" },
                title: { type: "string", minLength: 3, maxLength: 200 },
                description: { type: "string", minLength: 1, maxLength: 8_000 },
                acceptance_criteria: { type: "string", minLength: 1, maxLength: 4_000 },
                difficulty: { type: "string", enum: DIFFICULTIES },
                difficulty_reason: { type: "string", maxLength: 1_000 },
                phase: { type: "integer", minimum: 0 },
                phase_name: { type: "string", maxLength: 120 },
                order_index: { type: "integer", minimum: 0 },
                status: { type: "string", enum: TASK_STATUSES },
                worktree: { type: "string" },
                branch: { type: "string" },
                attempts: { type: "integer", minimum: 0, maximum: 20 },
                session_id: { type: "string" },
                review_route: { type: "object", additionalProperties: { type: "string" } },
                result: { type: "object", additionalProperties: true },
                last_error: { type: "string", maxLength: 4_000 },
                started_at: { type: "string" },
                finished_at: { type: "string" },
                assignee: { type: "string", enum: ASSIGNEES },
                model: { type: "string", maxLength: 160 },
                files_owned: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
                risk_flags: { type: "array", items: { type: "string" } },
                parallelizable: { type: "boolean" },
                depends_on: { type: "array", items: { type: "string" } },
              },
              required: ["task_id"],
              additionalProperties: false,
            },
          },
        },
        required: ["plan_id"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const planId = asString(input.plan_id);
        if (!UUID_RE.test(planId)) return fail("plan_id no es un UUID válido.");
        const plan = await deps.planStore.getPlan(project.projectId, planId);
        if (!plan) return fail("El plan no existe en este proyecto.");

        const requestedStatus = asPlanStatus(input.status);
        if (input.status !== undefined && !requestedStatus) return fail("status inválido.");
        const requestedAutonomy = asAutonomy(input.autonomy);
        if (input.autonomy !== undefined && !requestedAutonomy) return fail("autonomy inválida.");
        if (
          (requestedStatus === "approved" || requestedStatus === "executing" || requestedAutonomy === "autonomous") &&
          input.confirmed !== true
        ) {
          return fail("Aprobar el plan, ejecutarlo o activar autonomía total requiere confirmed=true.");
        }
        const decisions = parseReviewDecisions(input.review_decisions);
        if (decisions.some((item) => !item.finding || !item.evidence)) {
          return fail("Cada review_decision necesita finding, decision y evidence.");
        }

        const exhaustedDecision =
          typeof input.exhausted_decision === "string" ? input.exhausted_decision : "";
        const waiverText = asString(input.waiver).trim();
        if (exhaustedDecision && !["approve_with_waiver", "fix_and_revalidate", "cancel"].includes(exhaustedDecision)) {
          return fail("exhausted_decision inválido.");
        }
        if (["cancel", "fix_and_revalidate"].includes(exhaustedDecision)) {
          const extra = ["title", "status", "autonomy", "max_concurrency", "review_decisions", "tasks"].filter(
            (key) => input[key] !== undefined,
          );
          if (extra.length > 0) {
            return fail(`exhausted_decision=${exhaustedDecision} no se combina con otras mutaciones: ${extra.join(", ")}.`);
          }
        }
        const latestReviews = await deps.planStore.listPlanReviews(planId);
        const latest = latestReviews[0];
        const latestFindings = Array.isArray(latest?.findings) ? latest.findings : [];
        const allFindings = latestReviews.flatMap((review) =>
          Array.isArray(review.findings) ? review.findings : [],
        );
        const allSummary = summarizeFindings(allFindings);
        const latestSummary = summarizeFindings(latestFindings);

        if (exhaustedDecision === "cancel") {
          const updated = await deps.planStore.updatePlan(project.projectId, planId, {
            status: "cancelled",
            reviewExhausted: false,
            residualFindings: allSummary.list,
            approvalWaiver: {
              type: "cancelled",
              at: new Date().toISOString(),
              findings: allSummary.list,
            },
            approvedAt: null,
          });
          return ok({
            updated: true,
            plan: updated,
            cancelled: true,
            residual_findings: allSummary.list,
          });
        }
        if (exhaustedDecision === "fix_and_revalidate") {
          const updated = await deps.planStore.updatePlan(project.projectId, planId, {
            status: "review_pending",
            reviewExhausted: false,
            approvedAt: null,
          });
          return ok({
            updated: true,
            plan: updated,
            next: "Corrige, ejecuta plan_validate y llama plan_review con confirmed=true para una tercera ronda.",
          });
        }

        let waiverRecord: Record<string, unknown> = {};
        let residualFindings: unknown[] = [];
        let hasAcceptedBlocking = false;
        if (requestedStatus === "approved") {
          if (plan.validation.ok !== true) return fail("El plan no tiene una validación determinista en verde. Ejecuta plan_validate.");
          if (plan.reviewRound < 1) return fail("El plan no tiene revisión de plan. Ejecuta plan_review antes de aprobar.");
          const prior = Array.isArray(plan.reviewFindings)
            ? plan.reviewFindings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            : [];
          // Las decisiones de esta llamada tienen prioridad sobre las previas.
          const allDecisions = [...decisions, ...prior];
          const decisionFor = (finding: unknown) =>
            allDecisions.find((item) => decisionMatchesFinding(asString(item.finding), finding));
          const uncoveredBlocking = allSummary.blocking.filter((finding) => !decisionFor(finding));
          if (uncoveredBlocking.length > 0) {
            return fail(`Faltan review_decisions para ${uncoveredBlocking.length} hallazgo(s) bloqueante(s) de cualquier ronda.`);
          }
          const criticalHistory = allSummary.list.filter((finding) => finding.severity === "CRITICO");
          const criticalLatest = latestSummary.list.filter((finding) => finding.severity === "CRITICO");
          if (criticalHistory.length > 0 && (latest?.verdict !== "approved" || criticalLatest.length > 0)) {
            return fail("Hay hallazgos CRÍTICO en el historial; solo se cierran con una ronda posterior aprobada que ya no los reporte. No se pueden refutar ni waivear.");
          }
          const openBlocking = allSummary.blocking.filter(
            (finding) => finding.severity !== "CRITICO" && decisionFor(finding)?.decision !== "refuted",
          );
          const openAdvisory = allSummary.advisory.filter((finding) => decisionFor(finding)?.decision !== "refuted");
          hasAcceptedBlocking = openBlocking.length > 0;
          if (hasAcceptedBlocking && exhaustedDecision !== "approve_with_waiver") {
            return fail("Hay hallazgos bloqueantes abiertos; corrígelos, revalida y vuelve a revisar, o usa exhausted_decision=approve_with_waiver.");
          }
          if (openBlocking.length > 0) {
            if (exhaustedDecision !== "approve_with_waiver") {
              return fail("Hay hallazgos ALTO abiertos; usa exhausted_decision=approve_with_waiver con confirmed=true y justificación.");
            }
            if (!waiverText) return fail("El waiver de un hallazgo ALTO requiere justificación escrita en waiver.");
            waiverRecord = {
              type: "blocking_waiver",
              at: new Date().toISOString(),
              waiver: waiverText,
              findings: openBlocking,
            };
            residualFindings = [...openBlocking, ...openAdvisory];
          } else if (openAdvisory.length > 0) {
            waiverRecord = {
              type: "advisory_debt",
              at: new Date().toISOString(),
              findings: openAdvisory,
            };
            residualFindings = openAdvisory;
          } else {
            waiverRecord = {};
            residualFindings = [];
          }
        }
        if (requestedStatus === "executing" && (plan.status !== "approved" || !plan.approvedAt)) {
          return fail("El plan debe estar en estado approved antes de ejecutarse.");
        }

        const patches = Array.isArray(input.tasks) ? input.tasks : [];
        const changedStructure = patches.some((raw) => {
          const item = asRecord(raw);
          return ["files_owned", "depends_on", "assignee", "model", "title", "description", "acceptance_criteria", "difficulty", "phase", "worktree", "branch"].some(
            (key) => item[key] !== undefined,
          );
        });
        if (changedStructure && (requestedStatus === "approved" || requestedStatus === "executing")) {
          return fail("Cambiaste la estructura del plan; ejecuta plan_validate y luego aprueba en otra llamada.");
        }
        if (looksLikeSecret(JSON.stringify(patches))) {
          return fail("Los cambios de tareas parecen contener un secreto. No se guardaron.");
        }
        const preparedPatches: Array<{ taskId: string; patch: Parameters<PlanStore["updatePlanTask"]>[2] }> = [];
        for (const raw of patches) {
          const item = asRecord(raw);
          const taskId = asString(item.task_id);
          if (!UUID_RE.test(taskId)) return fail("Cada patch de tarea necesita task_id UUID.");
          const patch: Parameters<PlanStore["updatePlanTask"]>[2] = {};
          const status = asTaskStatus(item.status);
          if (item.status !== undefined && !status) return fail(`Estado de tarea inválido: ${String(item.status)}.`);
          const existingTask = await deps.planStore.getPlanTask(planId, taskId);
          if (!existingTask) return fail(`No existe la tarea ${taskId} en el plan.`);
          if (status === "merged") {
            return fail("El estado merged solo lo asigna subtask_integrate; no se fuerza desde plan_update.");
          }
          if (existingTask.status === "merged" && status && status !== "done") {
            return fail("Una tarea merged solo puede pasar a done; no se revierte a review/pending desde plan_update.");
          }
          if (status === "done" && existingTask.assignee === "implementer" && existingTask.status !== "merged") {
            return fail("Una tarea implementer no se marca done sin integración previa; usa subtask_integrate.");
          }
          if (status) patch.status = status;
          if (typeof item.title === "string") patch.title = item.title;
          if (typeof item.description === "string") patch.description = item.description;
          if (typeof item.acceptance_criteria === "string") patch.acceptanceCriteria = item.acceptance_criteria;
          const difficulty = asDifficulty(item.difficulty);
          if (item.difficulty !== undefined && !difficulty) return fail("difficulty inválida.");
          if (difficulty) patch.difficulty = difficulty;
          if (typeof item.difficulty_reason === "string") patch.difficultyReason = item.difficulty_reason;
          if (typeof item.phase === "number") patch.phase = Math.max(0, Math.round(item.phase));
          if (typeof item.phase_name === "string") patch.phaseName = item.phase_name;
          if (typeof item.order_index === "number") patch.orderIndex = Math.max(0, Math.round(item.order_index));
          if (typeof item.worktree === "string") {
            const worktree = item.worktree.trim();
            if (worktree && !worktree.startsWith(`${worktreeRoot(project.name)}/`)) {
              return fail("El worktree debe estar bajo ~/.local/share/opencode/worktrees/<proyecto>/.");
            }
            patch.worktree = worktree || null;
          }
          if (typeof item.branch === "string") {
            const branch = item.branch.trim();
            if (branch && !isSafeBranchName(branch)) return fail(`Rama no permitida: ${branch}.`);
            patch.branch = branch || null;
          }
          if (typeof item.attempts === "number") patch.attempts = Math.max(0, Math.round(item.attempts));
          if (typeof item.session_id === "string") patch.sessionId = item.session_id;
          if (item.review_route !== undefined) patch.reviewRoute = asRecord(item.review_route) as Record<string, string>;
          if (item.result !== undefined) {
            const result = asRecord(item.result);
            if ("integration_commit" in result || "integration_branch" in result) {
              return fail("integration_commit/integration_branch son evidencia de subtask_integrate; no se fijan con plan_update.");
            }
            patch.result = { ...existingTask.result, ...result };
          }
          if (typeof item.last_error === "string") patch.lastError = item.last_error;
          if (typeof item.started_at === "string") patch.startedAt = item.started_at;
          if (typeof item.finished_at === "string") patch.finishedAt = item.finished_at;
          const assignee = asAssignee(item.assignee);
          if (item.assignee !== undefined && !assignee) return fail("assignee inválido.");
          if (assignee) patch.assignee = assignee;
          if (typeof item.model === "string") patch.model = item.model;
          if (Array.isArray(item.files_owned)) patch.filesOwned = asStringArray(item.files_owned);
          if (Array.isArray(item.risk_flags)) patch.riskFlags = asStringArray(item.risk_flags);
          if (typeof item.parallelizable === "boolean") patch.parallelizable = item.parallelizable;
          if (Array.isArray(item.depends_on)) patch.dependsOn = asStringArray(item.depends_on);
          preparedPatches.push({ taskId, patch });
        }
        for (const { taskId, patch } of preparedPatches) {
          const updated = await deps.planStore.updatePlanTask(planId, taskId, patch);
          if (!updated) return fail(`No existe la tarea ${taskId} en el plan.`);
        }

        const currentFindings = Array.isArray(plan.reviewFindings) ? plan.reviewFindings : [];
        const acceptedBlockingNow =
          latest?.verdict === "changes_required" &&
          decisions.some(
            (item) =>
              item.decision === "accepted" &&
              isBlockingSeverity(decisionSeverity(item.finding, allFindings)),
          );
        const invalidates = changedStructure || hasAcceptedBlocking || acceptedBlockingNow;
        const invalidatedStatus: PlanStatus | undefined =
          invalidates && ["approved", "executing", "validated"].includes(plan.status)
            ? "review_pending"
            : undefined;
        const updated = await deps.planStore.updatePlan(project.projectId, planId, {
          title: typeof input.title === "string" ? input.title : undefined,
          status: requestedStatus ?? invalidatedStatus,
          autonomy: requestedAutonomy ?? undefined,
          maxConcurrency:
            typeof input.max_concurrency === "number" ? Math.round(input.max_concurrency) : undefined,
          reviewFindings: decisions.length > 0 ? [...currentFindings, ...decisions] : undefined,
          reviewExhausted:
            requestedStatus === "approved" ? waiverRecord.type === "blocking_waiver" : undefined,
          residualFindings: requestedStatus === "approved" ? residualFindings : undefined,
          approvalWaiver: requestedStatus === "approved" ? waiverRecord : undefined,
          validation: invalidates && requestedStatus !== "approved" ? {} : undefined,
          approvedAt:
            requestedStatus === "approved" ? new Date().toISOString() : invalidates ? null : undefined,
        });
        if (requestedAutonomy) {
          await deps.planStore.updateProjectSettings(project.projectId, { autonomy: requestedAutonomy });
        }
        if (typeof input.max_concurrency === "number") {
          await deps.planStore.updateProjectSettings(project.projectId, { maxConcurrency: input.max_concurrency });
        }
        const tasks = await deps.planStore.listPlanTasks(planId);
        return ok({
          updated: true,
          plan: updated,
          tasks,
          decisions: decisions.length,
          needs_validation: changedStructure,
          residual_findings: requestedStatus === "approved" ? residualFindings : undefined,
          approval_waiver: requestedStatus === "approved" ? waiverRecord : undefined,
        });
      },
    },
    {
      name: "plan_status",
      description: "Muestra el estado del plan, tareas, siguiente ola, bloqueos y coste acumulado.",
      input: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
        },
        required: ["plan_id"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const planId = asString(input.plan_id);
        if (!UUID_RE.test(planId)) return fail("plan_id no es un UUID válido.");
        const plan = await deps.planStore.getPlan(project.projectId, planId);
        if (!plan) return fail("El plan no existe en este proyecto.");
        const tasks = await deps.planStore.listPlanTasks(planId);
        const runs = await deps.planStore.listSubtaskRuns(planId);
        const reviews = await deps.planStore.listPlanReviews(planId);
        const closures = await deps.planStore.listPhaseClosures(planId);
        const active = tasks.filter((task) => ["running", "review"].includes(task.status)).map((task) => task.id);
        const wave = nextWave(tasks.map(toPlanTaskLike), active, plan.maxConcurrency);
        const subtaskCost = runs.reduce((sum, run) => sum + run.costUsd, 0);
        const reviewCost = reviews.reduce((sum, review) => sum + review.costUsd, 0);
        const phaseCost = closures.reduce((sum, closure) => sum + closure.costUsd, 0);
        return ok({
          plan,
          summary: planSummary(plan, tasks),
          next_wave: wave.wave.map((task) => ({ id: task.id, title: task.title, phase: task.phase, assignee: task.assignee })),
          deferred: wave.deferred,
          blocked: wave.blocked,
          tasks,
          runs,
          reviews,
          closures,
          usage: {
            subtask_cost_usd: Math.round(subtaskCost * 1_000_000) / 1_000_000,
            plan_review_cost_usd: Math.round(reviewCost * 1_000_000) / 1_000_000,
            phase_cost_usd: Math.round(phaseCost * 1_000_000) / 1_000_000,
            total_cost_usd: Math.round((subtaskCost + reviewCost + phaseCost) * 1_000_000) / 1_000_000,
          },
        });
      },
    },
    {
      name: "plan_validate",
      description:
        "Valida el plan de forma determinista: ciclos, criterios, archivos, solapamientos, tareas fáciles sensibles y orden de fases.",
      input: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
        },
        required: ["plan_id"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const planId = asString(input.plan_id);
        if (!UUID_RE.test(planId)) return fail("plan_id no es un UUID válido.");
        const plan = await deps.planStore.getPlan(project.projectId, planId);
        if (!plan) return fail("El plan no existe en este proyecto.");
        const tasks = await deps.planStore.listPlanTasks(planId);
        const validation = validatePlan(tasks.map(toPlanTaskLike));
        await deps.planStore.createPlanValidation({
          planId,
          status: validation.ok ? "pass" : "fail",
          errors: validation.errors,
          warnings: validation.warnings,
          waves: validation.waves,
        });
        const nextStatus: PlanStatus | undefined =
          validation.ok && ["draft", "review_pending", "validated"].includes(plan.status)
            ? "validated"
            : !validation.ok && ["validated", "approved", "executing", "paused"].includes(plan.status)
              ? "review_pending"
              : undefined;
        const updated = await deps.planStore.updatePlan(project.projectId, planId, {
          validation: validation as unknown as Record<string, unknown>,
          status: nextStatus,
          approvedAt: nextStatus === "review_pending" ? null : undefined,
        });
        return ok({
          ok: validation.ok,
          plan: updated ?? plan,
          errors: validation.errors,
          warnings: validation.warnings,
          waves: validation.waves,
        });
      },
    },
  ];
}
