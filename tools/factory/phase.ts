/**
 * Cierre de fase y reanudación.
 *
 * `phase_close` exige tareas integradas, gate verde en la rama de integración,
 * revisiones code/security/qa sobre el diff acumulado, memoria e informe.
 * `plan_resume` reconcilia tareas running/review con sesiones y worktrees.
 */

import { existsSync } from "node:fs";
import type { FactoryDb, FactoryProfile, ProjectRef } from "./db.js";
import type { PlanRecord, PlanStore, PlanTaskRecord } from "./plan-db.js";
import { isSensitiveTask, slugify } from "./paths.js";
import { MODELS, routeReview, sameFamily } from "./routing.js";
import { runCommand, shellQuote, tail } from "./exec.js";
import { fail, ok, type ToolDef } from "./types.js";

export interface PhaseToolsDeps {
  db: FactoryDb;
  planStore: PlanStore;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
  runtime: any;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_AGENTS: Record<string, string> = {
  security: "security-reviewer",
  code: "code-reviewer",
  qa: "qa-engineer",
};

function parseModel(model: string): { providerID: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { providerID: "opencode-go", id: model };
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function extractFinalText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (!message || message.type !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => String(item.text))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

async function waitWithTimeout(runtime: any, sessionID: string, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout del cierre de fase (${Math.round(timeoutMs / 1000)} s).`)), timeoutMs);
  });
  try {
    await Promise.race([runtime.session.wait({ sessionID }), timeout]);
  } catch (error) {
    await runtime.session.interrupt({ sessionID, resume: false }).catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function worktreeIsValid(path: string, cwd: string): Promise<boolean> {
  const result = await runCommand(`git -C ${shellQuote(path)} rev-parse --is-inside-work-tree`, cwd, 10_000);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function resolveBase(project: ProjectRef, profile: FactoryProfile | null): Promise<string> {
  const configured = profile?.conventions?.git;
  const preferred = configured && typeof configured === "object" && typeof (configured as Record<string, unknown>).baseBranch === "string"
    ? String((configured as Record<string, unknown>).baseBranch)
    : "main";
  for (const candidate of [preferred, "main", "master"]) {
    const result = await runCommand(`git rev-parse --verify --quiet ${shellQuote(`refs/heads/${candidate}`)}`, project.directory, 10_000);
    if (result.exitCode === 0) return candidate;
  }
  return "HEAD~1";
}

function usageOf(review: { tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }; costUsd: number; costSource: "provider" | "catalog" | "unknown"; sessionId: string | null }) {
  return {
    sessionId: review.sessionId,
    tokens: review.tokens,
    costUsd: review.costUsd,
    costSource: review.costSource,
    costBasis: null,
  };
}

export function createPhaseTools(deps: PhaseToolsDeps): ToolDef[] {
  return [
    {
      name: "phase_close",
      description:
        "Cierra una fase con tareas integradas, gate verde en integración, revisiones code/security/qa, memoria e informe de coste/tiempo.",
      input: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
          phase: { type: "integer", minimum: 0 },
          gate_run_id: { type: "string" },
          memory_id: { type: "string" },
          residual_risks: { type: "string", maxLength: 4_000 },
          confirmed: { type: "boolean", description: "Obligatorio en autonomía supervisada." },
          timeout_minutes: { type: "integer", minimum: 1, maximum: 45, default: 20 },
        },
        required: ["plan_id", "phase", "gate_run_id", "memory_id", "residual_risks"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const planId = String(input.plan_id ?? "").trim();
        const gateRunId = String(input.gate_run_id ?? "").trim();
        const memoryId = String(input.memory_id ?? "").trim();
        const phase = typeof input.phase === "number" ? Math.round(input.phase) : -1;
        if (!UUID_RE.test(planId) || !UUID_RE.test(gateRunId) || !UUID_RE.test(memoryId) || phase < 0) {
          return fail("plan_id, gate_run_id y memory_id deben ser UUID válidos, y phase >= 0.");
        }
        const plan = await deps.planStore.getPlan(project.projectId, planId);
        if (!plan) return fail("El plan no existe.");
        if (plan.autonomy === "supervised" && input.confirmed !== true) {
          return fail("El cierre de fase en autonomía supervisada requiere confirmed=true.");
        }
        const tasks = (await deps.planStore.listPlanTasks(planId)).filter((task) => task.phase === phase);
        if (tasks.length === 0) return fail(`La fase ${phase} no tiene tareas.`);
        const pending = tasks.filter((task) => !["merged", "done"].includes(task.status));
        if (pending.length > 0) {
          return fail(`Faltan tareas por integrar en la fase ${phase}: ${pending.map((task) => task.title).join(", ")}.`);
        }
        const existing = await deps.planStore.getPhaseClosure(planId, phase);
        if (existing) return fail(`La fase ${phase} ya tiene un cierre registrado.`);
        const gate = await deps.db.getGateRun(gateRunId);
        if (!gate || gate.projectId !== project.projectId) return fail("El gate_run no existe en este proyecto.");
        if (gate.status !== "pass") return fail("El gate_run no está en verde.");
        const integration = `factory/integration/${slugify(project.name)}`;
        if (gate.gitBranch !== integration) {
          return fail(`El gate_run no corresponde a la rama de integración ${integration}.`);
        }
        const memory = await deps.db.getMemory(memoryId);
        if (!memory) return fail("La memoria indicada no existe.");
        if (memory.scope === "project" && memory.projectId !== project.projectId) {
          return fail("La memoria es de otro proyecto.");
        }
        const profile = await deps.db.getProfile(project.projectId);
        const base = await resolveBase(project, profile);
        const sensitive = tasks.some((task) => isSensitiveTask(task));
        const roles = sensitive ? ["security", "code", "qa"] : ["code", "qa"];
        const authorModel = MODELS.orchestrator;
        const route = Object.fromEntries(roles.map((role) => [role, routeReview(authorModel, role as "security" | "code" | "qa")]));
        for (const role of roles) {
          if (sameFamily(authorModel, route[role]!)) return fail(`El revisor ${role} es de la misma familia que el orquestador.`);
        }

        const phaseTask = await deps.db.createTask({
          projectId: project.projectId,
          projectPath: project.directory,
          title: `Cierre fase ${phase} · ${plan.title}`.slice(0, 200),
          acceptanceCriteria: `Todas las tareas de la fase ${phase} integradas, gates verdes y revisiones aprobadas.`,
          status: "in_progress",
          result: null,
        });
        await deps.db.setTaskAuthorModel(project.projectId, phaseTask.id, authorModel);
        const diff = await runCommand(`git diff ${shellQuote(base)}...HEAD --`, project.directory, 60_000);
        const changed = await runCommand(`git diff --name-only ${shellQuote(base)}...HEAD --`, project.directory, 20_000);
        const diffText = diff.exitCode === 0 ? diff.stdout.slice(0, 100_000) : "";
        const changedText = changed.exitCode === 0 ? changed.stdout.trim() : "";
        const gateDetails = (Array.isArray(gate.gates) ? gate.gates : [])
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .filter((item) => ["test", "security"].includes(String(item.gate)))
          .map((item) => `${String(item.gate)}: ${String(item.status)} — ${String(item.evidence ?? "")}`)
          .join("\n");
        const criteriaText = tasks
          .map((task) => `- ${task.title}: ${task.acceptanceCriteria}`)
          .join("\n");
        const timeout = (typeof input.timeout_minutes === "number" ? Math.round(input.timeout_minutes) : 20) * 60_000;
        const sessions = await Promise.all(roles.map(async (role) => {
          const agent = REVIEW_AGENTS[role]!;
          const model = route[role]!;
          const session = await deps.runtime.session.create({
            parentID: String(context.sessionID),
            title: `${role} · cierre fase ${phase}`.slice(0, 120),
            agent,
            model: parseModel(model),
            location: { directory: project.directory },
          });
          const sessionID = String(session.id ?? "");
          if (!sessionID) throw new Error(`No se pudo crear la sesión ${role}.`);
          const prompt = [
            `Revisa el diff acumulado del cierre de la fase ${phase} del plan "${plan.title}".`,
            `task_id: ${phaseTask.id}`,
            `gate_run_id: ${gateRunId}`,
            `iteration: 1`,
            `model: ${model}`,
            `Rama de integración: ${integration}`,
            `Archivos cambiados: ${changedText || "(sin diff)"}`,
            "Criterios de aceptación de la fase:",
            criteriaText || "(sin criterios)",
            `Gate: ${gate.summary ?? "sin resumen"}`,
            gateDetails || "(sin evidencia de test/security)",
            "Nota: el gate ejecuta la suite completa del repo; el diff es solo el cambio acumulado de la fase. Los tests de baseline pueden aparecer en la evidencia del gate sin estar en el diff.",
            "Diff acumulado:",
            "```diff",
            diffText || "(sin diff)",
            "```",
            `Eres el revisor ${role}. No edites archivos. Al terminar, llama a review_submit con role="${role}", model="${model}", verdict, findings, summary, task_id, gate_run_id e iteration.`,
          ].join("\n");
          await deps.runtime.session.prompt({ sessionID, text: prompt });
          await waitWithTimeout(deps.runtime, sessionID, timeout);
          return { role, model, sessionID };
        }));

        const latest = await deps.db.getLatestReviews(phaseTask.id);
        const reviews = [];
        for (const role of roles) {
          const review = latest.find((item) => item.role === role);
          if (!review) {
            await deps.db.updateTask(project.projectId, phaseTask.id, { status: "blocked", result: `Falta review_submit de ${role}` });
            return fail(`El revisor ${role} no llamó a review_submit.`);
          }
          if (sameFamily(authorModel, review.model)) {
            return fail(`El revisor ${role} usó un modelo de la misma familia que el orquestador.`);
          }
          reviews.push(review);
        }
        const approved = reviews.every((review) => review.verdict === "approved" && review.openBlocking === 0);
        if (!approved) {
          await deps.db.updateTask(project.projectId, phaseTask.id, { status: "blocked", result: "Revisión de fase con cambios requeridos." });
          return ok({
            closed: false,
            phase,
            approved: false,
            reviews: reviews.map((review) => ({ role: review.role, verdict: review.verdict, open_blocking: review.openBlocking })),
            message: "La fase no se cierra hasta resolver los hallazgos.",
          });
        }

        const taskIds = tasks.map((task) => task.taskId).filter((id): id is string => Boolean(id));
        const subtaskRuns = (await deps.planStore.listSubtaskRuns(planId)).filter((run) => tasks.some((task) => task.id === run.planTaskId));
        let tokensInput = 0;
        let tokensOutput = 0;
        let tokensReasoning = 0;
        let tokensCacheRead = 0;
        let tokensCacheWrite = 0;
        let costUsd = 0;
        const perModel = new Map<string, { tokens: number; cost: number }>();
        const addUsage = (model: string, usage: { tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }; costUsd: number }) => {
          tokensInput += usage.tokens.input;
          tokensOutput += usage.tokens.output;
          tokensReasoning += usage.tokens.reasoning;
          tokensCacheRead += usage.tokens.cacheRead;
          tokensCacheWrite += usage.tokens.cacheWrite;
          costUsd += usage.costUsd;
          const bucket = perModel.get(model) ?? { tokens: 0, cost: 0 };
          bucket.tokens += usage.tokens.input + usage.tokens.output + usage.tokens.reasoning + usage.tokens.cacheRead + usage.tokens.cacheWrite;
          bucket.cost += usage.costUsd;
          perModel.set(model, bucket);
        };
        for (const run of subtaskRuns) {
          addUsage(run.model, { tokens: { input: run.tokensInput, output: run.tokensOutput, reasoning: run.tokensReasoning, cacheRead: run.tokensCacheRead, cacheWrite: run.tokensCacheWrite }, costUsd: run.costUsd });
        }
        for (const task of tasks) {
          if (!task.taskId) continue;
          for (const review of await deps.db.getLatestReviews(task.taskId)) {
            addUsage(review.model, { tokens: review.usage.tokens, costUsd: review.usage.costUsd });
          }
        }
        for (const review of reviews) {
          addUsage(review.model, { tokens: review.usage.tokens, costUsd: review.usage.costUsd });
        }
        const started = Math.min(...subtaskRuns.map((run) => Date.parse(run.startedAt)).filter(Number.isFinite));
        const finished = Math.max(...subtaskRuns.map((run) => Date.parse(run.finishedAt ?? run.startedAt)).filter(Number.isFinite));
        const elapsedMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
        const report = {
          closed_at: new Date().toISOString(),
          phase,
          plan_id: planId,
          tasks: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, attempts: task.attempts, model: task.model })),
          gate: { id: gate.id, status: gate.status, branch: gate.gitBranch, summary: gate.summary },
          reviews: reviews.map((review) => ({
            role: review.role,
            id: review.id,
            model: review.model,
            verdict: review.verdict,
            open_blocking: review.openBlocking,
            summary: review.summary,
          })),
          sensitive,
          security_applicable: sensitive,
          memory: { id: memory.id, scope: memory.scope, title: memory.title },
          residual_risks: String(input.residual_risks ?? "").slice(0, 4_000),
          review_exemptions: plan.residualFindings,
          approval_waiver: plan.approvalWaiver,
          usage: {
            tokens: {
              input: tokensInput,
              output: tokensOutput,
              reasoning: tokensReasoning,
              cache_read: tokensCacheRead,
              cache_write: tokensCacheWrite,
            },
            cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
            per_model: Array.from(perModel.entries()).map(([model, value]) => ({
              model,
              tokens: value.tokens,
              cost_usd: Math.round(value.cost * 1_000_000) / 1_000_000,
            })).sort((left, right) => right.cost_usd - left.cost_usd),
          },
          elapsed_ms: elapsedMs,
          delegated_tasks: tasks.filter((task) => task.assignee === "implementer").length,
          escalated_tasks: tasks.filter((task) => task.status === "escalated" || task.attempts > 1).length,
        };
        const closure = await deps.planStore.createPhaseClosure({
          planId,
          phase,
          status: "closed",
          gateRunId,
          codeReviewId: reviews.find((review) => review.role === "code")?.id ?? null,
          securityReviewId: reviews.find((review) => review.role === "security")?.id ?? null,
          report,
          usage: {
            tokens: { input: tokensInput, output: tokensOutput, reasoning: tokensReasoning, cacheRead: tokensCacheRead, cacheWrite: tokensCacheWrite },
            costUsd,
            costSource: "unknown",
          },
        });
        await deps.db.closeTask(project.projectId, phaseTask.id, report, `Fase ${phase} cerrada; gate ${gate.id.slice(0, 8)}; ${reviews.length} revisiones aprobadas.`);
        const allTasks = await deps.planStore.listPlanTasks(planId);
        const phases = [...new Set(allTasks.map((task) => task.phase))];
        const closures = await deps.planStore.listPhaseClosures(planId);
        const complete = phases.every((phaseNumber) => closures.some((item) => item.phase === phaseNumber));
        await deps.planStore.updatePlan(project.projectId, planId, {
          status: complete ? "completed" : "executing",
        });
        return ok({ closed: true, phase, closure, report });
      },
    },
    {
      name: "plan_resume",
      description: "Reconcilia tareas running/review con sesiones y worktrees; detecta huérfanas y deja acciones claras para reanudar.",
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
        const planId = String(input.plan_id ?? "").trim();
        if (!UUID_RE.test(planId)) return fail("plan_id no es un UUID válido.");
        const plan = await deps.planStore.getPlan(project.projectId, planId);
        if (!plan) return fail("El plan no existe.");
        const tasks = await deps.planStore.listPlanTasks(planId);
        const worktrees = await runCommand("git worktree list --porcelain", project.directory, 20_000);
        const known = new Set(
          worktrees.exitCode === 0
            ? worktrees.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length).trim())
            : [],
        );
        const actions: Array<Record<string, unknown>> = [];
        for (const task of tasks) {
          if (!["running", "review"].includes(task.status)) continue;
          if (!task.worktree || !existsSync(task.worktree)) {
            await deps.planStore.updatePlanTask(planId, task.id, { status: "failed", lastError: "Worktree ausente al reanudar." });
            actions.push({ task_id: task.id, action: "marked_failed", reason: "worktree ausente" });
            continue;
          }
          if (!(await worktreeIsValid(task.worktree, project.directory))) {
            await deps.planStore.updatePlanTask(planId, task.id, {
              status: task.attempts >= 2 ? "escalated" : "failed",
              lastError: "Worktree con .git roto al reanudar.",
            });
            actions.push({
              task_id: task.id,
              action: task.attempts >= 2 ? "escalated" : "marked_failed",
              reason: "worktree con .git roto",
            });
            continue;
          }
          if (!known.has(task.worktree)) {
            actions.push({ task_id: task.id, action: "warn", reason: "worktree no registrado por git" });
          }
          if (!task.sessionId) {
            actions.push({ task_id: task.id, action: "retryable", reason: "sin session_id; usa subtask_run" });
            continue;
          }
          try {
            const session = await deps.runtime.session.get({ sessionID: task.sessionId });
            const outcome = session?.outcome;
            if (outcome === "failed" || outcome === "interrupted") {
              await deps.planStore.updatePlanTask(planId, task.id, {
                status: task.attempts >= 2 ? "escalated" : "failed",
                lastError: `Sesión ${outcome} al reanudar.`,
              });
              actions.push({ task_id: task.id, action: task.attempts >= 2 ? "escalated" : "retryable", reason: `sesión ${outcome}` });
            } else {
              actions.push({ task_id: task.id, action: "still_active", session_id: task.sessionId, status: task.status });
            }
          } catch {
            await deps.planStore.updatePlanTask(planId, task.id, {
              status: task.attempts >= 2 ? "escalated" : "failed",
              lastError: "Sesión no encontrada al reanudar.",
            });
            actions.push({ task_id: task.id, action: task.attempts >= 2 ? "escalated" : "retryable", reason: "sesión no encontrada" });
          }
        }
        const updatedTasks = await deps.planStore.listPlanTasks(planId);
        return ok({
          plan_id: planId,
          actions,
          worktrees_known: [...known],
          tasks: updatedTasks.map((task) => ({ id: task.id, title: task.title, status: task.status, attempts: task.attempts, worktree: task.worktree, session_id: task.sessionId })),
        });
      },
    },
  ];
}
