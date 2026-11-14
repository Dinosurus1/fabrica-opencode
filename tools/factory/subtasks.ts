/**
 * Ejecución de subtareas en worktrees y revisión por familias distintas.
 *
 * Qué hace:
 *  - `subtask_run`: crea worktree/rama/sesión `implementer`, espera, valida el
 *    diff contra `files_owned` y registra el resultado.
 *  - `review_run`: lanza code/security/qa en paralelo con modelos de otra
 *    familia, exige `review_submit` y actualiza la tarea del plan.
 *  - `subtask_integrate`: verifica gates/reviews y fusiona en la rama de
 *    integración; nunca en main/master/develop.
 *
 * No hace push. No fusiona conflictos: los devuelve al orquestador.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FactoryDb, FactoryProfile, ProjectRef, ReviewUsage } from "./db.js";
import type { PlanStore, PlanTaskRecord, PlanRecord } from "./plan-db.js";
import type { MamRuntime } from "./mam.js";
import { isSensitiveTask, filesOutsideOwned, isSafeBranchName, matchesGlob, slugify, worktreeRoot } from "./paths.js";
import { routeReviewMap, sameFamily } from "./routing.js";
import {
  estimateReserveCost,
  estimateReserveTokens,
  releaseExecution,
  reserveExecution,
  settleExecution,
  toolVersions,
  usageTotals,
} from "./budget.js";
import { activeMode, selectModel, type WorkMode } from "./model-selection.js";
import { runCommand, shellQuote, tail } from "./exec.js";
import { captureUsage, emptyUsage, type SessionUsageSnapshot, type UsageDeps } from "./usage.js";
import { fail, ok, type ToolDef } from "./types.js";

export interface SubtaskToolsDeps {
  db: FactoryDb;
  planStore: PlanStore;
  mam: MamRuntime;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
  permission: { assert: (input: Record<string, unknown>) => Promise<void> };
  usage: UsageDeps;
  runtime: any;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_AGENTS: Record<string, string> = {
  security: "security-reviewer",
  code: "code-reviewer",
  qa: "qa-engineer",
};

function worktreePath(project: ProjectRef, plan: PlanRecord, task: PlanTaskRecord): string {
  return join(worktreeRoot(project.name), `plan-${plan.id.slice(0, 8)}-${task.id.slice(0, 8)}`);
}

function parseModel(model: string): { providerID: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { providerID: "opencode-go", id: model };
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function configuredBaseBranch(profile: FactoryProfile | null): string {
  const git = profile?.conventions?.git;
  if (git && typeof git === "object" && typeof (git as Record<string, unknown>).baseBranch === "string") {
    return String((git as Record<string, unknown>).baseBranch);
  }
  return "main";
}

async function resolveBaseBranch(cwd: string, profile: FactoryProfile | null): Promise<string> {
  const configured = configuredBaseBranch(profile);
  for (const candidate of [configured, "main", "master"]) {
    const exists = await runCommand(
      `git rev-parse --verify --quiet ${shellQuote(`refs/heads/${candidate}`)}`,
      cwd,
      10_000,
    );
    if (exists.exitCode === 0) return candidate;
  }
  const parent = await runCommand("git rev-parse --verify --quiet HEAD~1", cwd, 10_000);
  return parent.exitCode === 0 ? "HEAD~1" : "HEAD";
}

async function git(
  deps: SubtaskToolsDeps,
  context: { sessionID: string; agent: string; messageID: string; id: string },
  command: string,
  cwd: string,
  timeout = 60_000,
) {
  await deps.permission.assert({
    sessionID: String(context.sessionID),
    agent: context.agent,
    source: { type: "tool", messageID: String(context.messageID), id: String(context.id) },
    action: "shell",
    resources: [command],
    save: [command],
    metadata: { tool: "subtask" },
  });
  return runCommand(command, cwd, timeout);
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
    timer = setTimeout(() => reject(new Error(`Timeout de la subtarea (${Math.round(timeoutMs / 1000)} s).`)), timeoutMs);
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

function implementerPermissions(worktree: string): Array<Record<string, string>> {
  return [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "edit", resource: `${worktree}/**`, effect: "allow" },
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "external_directory", resource: `${worktree}/*`, effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "review_submit", resource: "*", effect: "deny" },
  ];
}

async function ensureCommitted(
  deps: SubtaskToolsDeps,
  context: { sessionID: string; agent: string; messageID: string; id: string },
  worktree: string,
  branch: string,
  title: string,
  filesOwned: readonly string[],
): Promise<void> {
  const status = await runCommand("git status --porcelain --untracked-files=all", worktree, 20_000);
  if (status.exitCode !== 0) throw new Error("No se pudo leer git status del worktree.");
  if (!status.stdout.trim()) return;
  const changed = status.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => (file.includes(" -> ") ? file.split(" -> ").pop()!.trim() : file))
    .filter(Boolean);
  const allowed = changed.filter((file) => filesOwned.some((pattern) => matchesGlob(pattern, file)));
  if (allowed.length === 0) {
    throw new Error("El implementer no cambió archivos permitidos; no se commitea nada.");
  }
  await deps.permission.assert({
    sessionID: String(context.sessionID),
    agent: context.agent,
    source: { type: "tool", messageID: String(context.messageID), id: String(context.id) },
    action: "git.commit",
    resources: [branch],
    save: [],
    metadata: { tool: "subtask_run", branch, reason: "implementer dejó cambios sin commit" },
  });
  const add = await runCommand(`git add -- ${allowed.map(shellQuote).join(" ")}`, worktree, 60_000);
  if (add.exitCode !== 0) throw new Error(`git add falló: ${tail(add.stderr || add.stdout, 500)}`);
  const message = `chore: subtask ${title}`.slice(0, 300);
  const commit = await runCommand(`git commit -m ${shellQuote(message)}`, worktree, 120_000);
  if (commit.exitCode !== 0) throw new Error(`git commit falló: ${tail(commit.stderr || commit.stdout, 500)}`);
}

async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const baseDiff = await runCommand(`git diff --name-only ${shellQuote(base)}...HEAD --`, cwd, 20_000);
  const changed = baseDiff.exitCode === 0
    ? baseDiff.stdout
    : (await runCommand("git diff --name-only HEAD --", cwd, 20_000)).stdout;
  const worktreeDiff = await runCommand("git diff --name-only HEAD --", cwd, 20_000);
  const untracked = await runCommand("git ls-files --others --exclude-standard", cwd, 20_000);
  return [...new Set(
    [changed, worktreeDiff.exitCode === 0 ? worktreeDiff.stdout : "", untracked.exitCode === 0 ? untracked.stdout : ""]
      .join("\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  )];
}

async function getWorktree(
  deps: SubtaskToolsDeps,
  project: ProjectRef,
  profile: FactoryProfile | null,
  plan: PlanRecord,
  task: PlanTaskRecord,
  context: { sessionID: string; agent: string; messageID: string; id: string },
): Promise<{ worktree: string; branch: string } | { error: string }> {
  const branch = task.branch ?? `factory/${plan.id.slice(0, 6)}-${slugify(task.title)}`;
  if (!isSafeBranchName(branch)) {
    return { error: `Rama no permitida: ${branch}.` };
  }
  let worktree = task.worktree;
  if (!worktree) {
    worktree = worktreePath(project, plan, task);
  } else if (worktree.startsWith("/tmp/") && !existsSync(worktree)) {
    // Los worktrees efímeros de /tmp se recrean en la raíz persistente.
    worktree = worktreePath(project, plan, task);
  }
  if (!inside(worktreeRoot(project.name), worktree)) {
    return { error: "El worktree está fuera de ~/.local/share/opencode/worktrees/<proyecto>/." };
  }
  if (existsSync(worktree)) {
    const valid = await runCommand(
      `git -C ${shellQuote(worktree)} rev-parse --is-inside-work-tree`,
      project.directory,
      15_000,
    );
    if (valid.exitCode !== 0 || valid.stdout.trim() !== "true") {
      return { error: "El worktree existe pero su .git está roto; usa plan_resume o factory_doctor." };
    }
  } else {
    mkdirSync(dirname(worktree), { recursive: true });
    const base = await resolveBaseBranch(project.directory, profile);
    const branchExists = await runCommand(
      `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`,
      project.directory,
      15_000,
    );
    const command = branchExists.exitCode === 0
      ? `git worktree add ${shellQuote(worktree)} ${shellQuote(branch)}`
      : `git worktree add -b ${shellQuote(branch)} ${shellQuote(worktree)} ${shellQuote(base)}`;
    const added = await git(deps, context, command, project.directory, 120_000);
    if (added.exitCode !== 0) {
      return { error: tail(added.stderr || added.stdout || "git worktree add falló", 800) };
    }
  }
  const current = await runCommand("git branch --show-current", worktree, 15_000);
  if (current.exitCode !== 0) return { error: "El worktree no es un repositorio git válido." };
  if (current.stdout.trim() !== branch) {
    const exists = await runCommand(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`, worktree, 15_000);
    const command = exists.exitCode === 0
      ? `git switch ${shellQuote(branch)}`
      : `git switch -c ${shellQuote(branch)}`;
    const switched = await git(deps, context, command, worktree, 30_000);
    if (switched.exitCode !== 0) return { error: tail(switched.stderr || switched.stdout || "git switch falló", 500) };
  }
  return { worktree, branch };
}

async function runOne(
  deps: SubtaskToolsDeps,
  project: ProjectRef,
  profile: FactoryProfile | null,
  plan: PlanRecord,
  task: PlanTaskRecord,
  context: { sessionID: string; agent: string; messageID: string; id: string },
  timeoutMinutes: number,
  mode: WorkMode,
  confirmed: boolean,
  parentExecutionId: string | null = null,
): Promise<Record<string, unknown>> {
  const attempts = task.attempts + 1;
  let selection;
  try {
    selection = await selectModel({
      mam: deps.mam,
      projectId: project.projectId,
      planId: plan.id,
      task,
      role: "implementer",
      mode,
      agentId: "implementer",
      confirmed,
      attempt: attempts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.planStore.updatePlanTask(plan.id, task.id, {
      status: "blocked",
      lastError: message,
      finishedAt: new Date().toISOString(),
    });
    return { task_id: task.id, status: "blocked", error: message };
  }
  if (selection.requiresApproval) {
    return {
      task_id: task.id,
      status: "needs_approval",
      proposed_model: selection.model,
      reason: selection.reason,
      message: "El modo híbrido requiere aprobación antes de lanzar esta tarea.",
    };
  }
  const effectiveTask = { ...task, model: selection.model };
  const prepared = await getWorktree(deps, project, profile, plan, effectiveTask, context);
  if ("error" in prepared) {
    await deps.planStore.updatePlanTask(plan.id, task.id, { status: "failed", lastError: prepared.error, finishedAt: new Date().toISOString() });
    return { task_id: task.id, status: "failed", error: prepared.error };
  }
  const { worktree, branch } = prepared;
  const route = routeReviewMap(effectiveTask.model);
  let taskRow = task.taskId ? await deps.db.getTask(project.projectId, task.taskId) : null;
  if (!taskRow) {
    taskRow = await deps.db.createTask({
      projectId: project.projectId,
      projectPath: project.directory,
      title: task.title,
      acceptanceCriteria: task.acceptanceCriteria,
      status: "in_progress",
      result: null,
    });
  }
  await deps.db.setTaskAuthorModel(project.projectId, taskRow.id, effectiveTask.model);
  await deps.planStore.updatePlanTask(plan.id, task.id, {
    taskId: taskRow.id,
    worktree,
    branch,
    attempts,
    status: "running",
    startedAt: new Date().toISOString(),
    reviewRoute: route,
    model: effectiveTask.model,
    lastError: null,
  });
  const run = await deps.planStore.createSubtaskRun({
    planId: plan.id,
    planTaskId: task.id,
    taskId: taskRow.id,
    sessionId: null,
    worktree,
    branch,
    model: effectiveTask.model,
    status: "running",
    summary: null,
    result: {},
    usage: emptyUsage(null),
  });

  const reserveTokens = estimateReserveTokens(task.difficulty, selection.maxTokens);
  const reserveCost = await estimateReserveCost(
    deps.mam.store,
    selection.providerId,
    selection.modelId,
    reserveTokens,
    selection.maxCostUsd,
  );
  let executionId: string;
  try {
    executionId = await deps.mam.store.startExecution({
      projectId: project.projectId,
      phase: task.phase,
      parentExecutionId,
      profileId: selection.profileId,
      agentId: "implementer",
      providerId: selection.providerId,
      modelId: selection.modelId,
      role: "implementer",
      taskId: taskRow.id,
      planId: plan.id,
      mode,
      selectionReason: selection.reason,
      attempt: attempts,
      toolVersions: toolVersions(deps.runtime),
      priceVersion: await deps.mam.store.priceVersion(),
      metadata: {
        difficulty: task.difficulty,
        risk_flags: task.riskFlags,
        plan_task_id: task.id,
        reserved_tokens: reserveTokens,
        reserved_cost_usd: reserveCost,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.planStore.updateSubtaskRun(run.id, {
      status: "failed",
      summary: `No se pudo abrir el execution log: ${message}`,
      result: { error: message },
      usage: emptyUsage(null),
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    await deps.planStore.updatePlanTask(plan.id, task.id, {
      status: "failed",
      lastError: message,
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    return { task_id: task.id, status: "failed", error: message };
  }

  let budgetReserved = false;
  let executionClosed = false;
  const closeExecution = async (status: string, usage: ReviewUsage, error: string | null) => {
    if (executionClosed) return;
    executionClosed = true;
    const totals = usageTotals(usage);
    if (budgetReserved) {
      await settleExecution(deps.mam, executionId, totals.tokens, totals.costUsd).catch(() => undefined);
    } else {
      await releaseExecution(deps.mam, executionId).catch(() => undefined);
    }
    await deps.mam.store.finishExecution(executionId, {
      status,
      tokensInput: usage.tokens.input,
      tokensOutput: usage.tokens.output,
      tokensReasoning: usage.tokens.reasoning,
      tokensCacheRead: usage.tokens.cacheRead,
      tokensCacheWrite: usage.tokens.cacheWrite,
      costUsd: usage.costUsd,
      costSource: usage.costSource,
      error,
    }).catch(() => undefined);
  };

  let reservation;
  try {
    reservation = await reserveExecution(deps.mam, {
      executionId,
      projectId: project.projectId,
      planId: plan.id,
      phase: task.phase,
      taskId: taskRow.id,
      tokens: reserveTokens,
      costUsd: reserveCost,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closeExecution("budget_error", emptyUsage(null), message);
    await deps.planStore.updateSubtaskRun(run.id, {
      status: "failed",
      summary: `No se pudo reservar presupuesto: ${message}`,
      result: { error: message },
      usage: emptyUsage(null),
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    await deps.planStore.updatePlanTask(plan.id, task.id, {
      status: "failed",
      lastError: message,
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    return { task_id: task.id, status: "failed", error: message };
  }
  if (!reservation.ok) {
    const message = `Presupuesto insuficiente: la reserva de ${reserveTokens} tokens / ${reserveCost.toFixed(4)} USD no cabe en el saldo global, de fase o de tarea.`;
    await closeExecution("budget_rejected", emptyUsage(null), message);
    await deps.planStore.updateSubtaskRun(run.id, {
      status: "failed",
      summary: message,
      result: { error: message, reservation },
      usage: emptyUsage(null),
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    await deps.planStore.updatePlanTask(plan.id, task.id, {
      status: "failed",
      lastError: message,
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    return { task_id: task.id, status: "failed", error: message, reservation };
  }
  budgetReserved = true;

  const prompt = [
    `Implementa esta tarea en el worktree asignado.`,
    `Proyecto: ${project.directory}`,
    `Worktree: ${worktree}`,
    `Rama: ${branch}`,
    `Tarea: ${task.title}`,
    `Descripción: ${task.description}`,
    `Criterio de aceptación: ${task.acceptanceCriteria}`,
    `Modelo asignado: ${selection.model}`,
    `Presupuesto de la tarea: ${selection.maxTokens ?? "sin límite"} tokens / ${selection.maxCostUsd ?? "sin límite"} USD`,
    `Archivos permitidos (globs): ${task.filesOwned.join(", ")}`,
    `No ejecutes shell, no lances subagentes, no edites fuera de los archivos permitidos y no hagas push.`,
    `No commitees: el orquestador hará un commit controlado de tus cambios en esta rama.`,
    `Si no puedes completar la tarea, explica el bloqueo sin tocar archivos fuera de alcance.`,
    `Trabaja de forma pequeña y verificable; el orquestador ejecutará las compuertas después.`,
  ].join("\n");

  let sessionID = "";
  try {
    const session = await deps.runtime.session.create({
      parentID: String(context.sessionID),
      title: `Implementer · ${task.title}`.slice(0, 120),
      agent: "implementer",
      model: parseModel(effectiveTask.model),
      location: { directory: worktree },
      permissions: implementerPermissions(worktree),
    });
    sessionID = String(session.id ?? "");
    if (!sessionID) throw new Error("No se pudo crear la sesión del implementer.");
    await deps.planStore.updatePlanTask(plan.id, task.id, { sessionId: sessionID });
    await deps.planStore.updateSubtaskRun(run.id, { sessionId: sessionID });
    await deps.mam.store.setExecutionSession(executionId, sessionID);
    await deps.runtime.session.prompt({ sessionID, text: prompt });
    await waitWithTimeout(deps.runtime, sessionID, Math.max(1, timeoutMinutes) * 60_000);
    const messages = await deps.runtime.session.context({ sessionID });
    const summary = extractFinalText(messages);
    const snapshot = (await deps.usage.getSessionUsage(sessionID)) as SessionUsageSnapshot | null;
    const price = snapshot
      ? await deps.usage.getModelPrice(snapshot.model || effectiveTask.model, snapshot.tokens.input + snapshot.tokens.cacheRead)
      : null;
    const usage = snapshot ? captureUsage(snapshot, price, sessionID) : emptyUsage(sessionID);
    const totals = usageTotals(usage);
    const budgetError =
      (selection.maxTokens !== null && totals.tokens > selection.maxTokens) ||
      (selection.maxCostUsd !== null && totals.costUsd > selection.maxCostUsd)
        ? `Presupuesto excedido: ${totals.tokens} tokens / ${totals.costUsd.toFixed(4)} USD; límite ${selection.maxTokens ?? "sin límite"} tokens / ${selection.maxCostUsd ?? "sin límite"} USD.`
        : null;

    const base = await resolveBaseBranch(worktree, profile);
    const filesBefore = await changedFiles(worktree, base);
    if (filesBefore.length === 0) throw new Error("El implementer no cambió archivos.");
    const outside = filesOutsideOwned(filesBefore, task.filesOwned);
    const headBefore = await runCommand("git rev-parse --short HEAD", worktree, 15_000);
    const commitBefore = headBefore.exitCode === 0 ? headBefore.stdout.trim() : null;
    if (outside.length > 0) {
      // No se commitea nada si hay archivos fuera de alcance: el reintento
      // parte del mismo estado y no hereda un commit contaminado.
      const result = { summary, files: filesBefore, files_outside: outside, commit: commitBefore, stdout: summary.slice(0, 8_000) };
      const escalation = attempts >= 2;
      await closeExecution(
        escalation ? "escalated" : "failed",
        usage,
        `Cambios fuera de files_owned: ${outside.join(", ")}`,
      );
      await deps.planStore.updateSubtaskRun(run.id, {
        status: escalation ? "escalated" : "failed",
        summary: `Cambios fuera de files_owned: ${outside.join(", ")}`,
        result,
        usage,
        finishedAt: new Date().toISOString(),
      });
      await deps.planStore.updatePlanTask(plan.id, task.id, {
        status: escalation ? "escalated" : "failed",
        attempts,
        result,
        lastError: `Cambios fuera de files_owned: ${outside.join(", ")}`,
        finishedAt: new Date().toISOString(),
      });
      return {
        task_id: task.id,
        status: escalation ? "escalated" : "failed",
        error: "Cambios fuera de files_owned.",
        files: filesBefore,
        files_outside: outside,
        session_id: sessionID,
      };
    }

    // El implementer puede olvidar commitear. El commit sigue siendo controlado:
    // se exige git.commit y solo se ejecuta en su rama no protegida.
    await ensureCommitted(deps, {
      sessionID: String(context.sessionID),
      agent: context.agent,
      messageID: String(context.messageID),
      id: String(context.id),
    }, worktree, branch, task.title, task.filesOwned);

    const status = await runCommand("git status --porcelain", worktree, 20_000);
    if (status.exitCode !== 0) throw new Error("No se pudo leer git status del worktree.");
    if (status.stdout.trim()) {
      throw new Error("El worktree sigue con cambios sin commit después del cierre controlado.");
    }
    const files = filesBefore;
    const commitResult = await runCommand("git rev-parse --short HEAD", worktree, 15_000);
    const commit = commitResult.exitCode === 0 ? commitResult.stdout.trim() : null;
    const result = { summary, files, commit, session_id: sessionID, worktree, branch, usage };
    if (budgetError) {
      await closeExecution("budget_exceeded", usage, budgetError);
      await deps.planStore.updateSubtaskRun(run.id, {
        status: attempts >= 2 ? "escalated" : "failed",
        summary: budgetError,
        result,
        usage,
        finishedAt: new Date().toISOString(),
      });
      await deps.planStore.updatePlanTask(plan.id, task.id, {
        status: attempts >= 2 ? "escalated" : "failed",
        attempts,
        result,
        lastError: budgetError,
        finishedAt: new Date().toISOString(),
      });
      return {
        task_id: task.id,
        status: attempts >= 2 ? "escalated" : "failed",
        error: budgetError,
        session_id: sessionID,
        worktree,
        branch,
        files,
        commit,
        summary: summary.slice(0, 2_000),
      };
    }
    await closeExecution("done", usage, null);
    await deps.planStore.updateSubtaskRun(run.id, {
      status: "done",
      summary: summary.slice(0, 8_000),
      result,
      usage,
      finishedAt: new Date().toISOString(),
    });
    await deps.planStore.updatePlanTask(plan.id, task.id, {
      status: "review",
      result,
      lastError: null,
      finishedAt: new Date().toISOString(),
    });
    return { task_id: task.id, status: "review", session_id: sessionID, worktree, branch, files, commit, summary: summary.slice(0, 2_000), model: effectiveTask.model, selection_reason: selection.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const escalate = attempts >= 2;
    const snapshot = sessionID ? await deps.usage.getSessionUsage(sessionID).catch(() => null) : null;
    const price = snapshot
      ? await deps.usage.getModelPrice(snapshot.model || effectiveTask.model, snapshot.tokens.input + snapshot.tokens.cacheRead)
      : null;
    const usage = snapshot ? captureUsage(snapshot, price, sessionID || null) : emptyUsage(sessionID || null);
    await closeExecution(escalate ? "escalated" : "failed", usage, message);
    await deps.planStore.updateSubtaskRun(run.id, {
      status: escalate ? "escalated" : "failed",
      summary: message,
      result: { error: message, attempts },
      usage,
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    await deps.planStore.updatePlanTask(plan.id, task.id, {
      status: escalate ? "escalated" : "failed",
      attempts,
      lastError: message,
      finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
    return {
      task_id: task.id,
      status: escalate ? "escalated" : "failed",
      error: message,
      session_id: sessionID || null,
      attempts,
    };
  }
}

export function createSubtaskTools(deps: SubtaskToolsDeps): ToolDef[] {
  return [
    {
      name: "subtask_run",
      description:
        "Ejecuta una o varias tareas del plan en worktrees y sesiones implementer en paralelo; valida el diff contra files_owned.",
      input: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
          task_ids: { type: "array", items: { type: "string" }, minItems: 1 },
          timeout_minutes: { type: "integer", minimum: 1, maximum: 60, default: 20 },
          mode: { type: "string", enum: ["auto", "manual", "hybrid"] },
          confirmed: { type: "boolean", default: false },
        },
        required: ["plan_id", "task_ids"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const planId = String(input.plan_id ?? "").trim();
        if (!UUID_RE.test(planId)) return fail("plan_id no es un UUID válido.");
        const plan = await deps.planStore.getPlan(project.projectId, planId);
        if (!plan) return fail("El plan no existe en este proyecto.");
        if (!["approved", "executing"].includes(plan.status)) {
          return fail("El plan debe estar aprobado antes de ejecutar subtareas.");
        }
        const requested = Array.isArray(input.task_ids)
          ? input.task_ids.filter((id): id is string => typeof id === "string" && UUID_RE.test(id))
          : [];
        if (requested.length === 0) return fail("Indica al menos un task_id válido.");
        if (requested.length > plan.maxConcurrency) {
          return fail(`Pediste ${requested.length} tareas y max_concurrency es ${plan.maxConcurrency}.`);
        }
        const tasks = await deps.planStore.listPlanTasks(planId);
        const selected: PlanTaskRecord[] = [];
        for (const id of requested) {
          const task = tasks.find((item) => item.id === id);
          if (!task) return fail(`La tarea ${id} no existe en el plan.`);
          if (task.assignee !== "implementer") {
            return fail(`La tarea "${task.title}" está asignada al orquestador; no se delega a un implementer.`);
          }
          const retryable = ["failed", "blocked"].includes(task.status) && task.attempts < 2;
          if (!["pending", "ready"].includes(task.status) && !retryable) {
            return fail(`La tarea "${task.title}" está en ${task.status}; no se puede iniciar.`);
          }
          selected.push(task);
        }
        const profile = await deps.db.getProfile(project.projectId);
        const mode = (
          typeof input.mode === "string" && ["auto", "manual", "hybrid"].includes(input.mode)
            ? input.mode
            : await activeMode(deps.mam)
        ) as WorkMode;
        const confirmed = input.confirmed === true;
        const timeout = typeof input.timeout_minutes === "number" ? Math.round(input.timeout_minutes) : 20;
        let parentExecutionId: string;
        try {
          parentExecutionId = await deps.mam.store.startExecution({
            projectId: project.projectId,
            agentId: "factory",
            role: "orchestration",
            planId,
            mode,
            selectionReason: "subtask_run: orquestación de la ola",
            attempt: 1,
            toolVersions: toolVersions(deps.runtime),
            priceVersion: await deps.mam.store.priceVersion(),
            metadata: {
              tool: "subtask_run",
              tasks: selected.map((task) => task.id),
            },
          });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
        const results = await Promise.all(
          selected.map(async (task) => {
            try {
              return await runOne(deps, project, profile, plan, task, {
                sessionID: String(context.sessionID),
                agent: context.agent,
                messageID: String(context.messageID),
                id: String(context.id),
              }, timeout, mode, confirmed, parentExecutionId);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await deps.planStore.updatePlanTask(plan.id, task.id, {
                status: "failed",
                lastError: message,
                finishedAt: new Date().toISOString(),
              }).catch(() => undefined);
              return { task_id: task.id, status: "failed", error: message };
            }
          }),
        );
        const allOk = results.every((result) => result.status === "review");
        await deps.mam.store.finishExecution(parentExecutionId, {
          status: allOk ? "done" : "failed",
          error: allOk ? null : "Una o más subtareas no terminaron en review.",
          metadata: {
            results: results.map((result) => ({
              task_id: result.task_id,
              status: result.status,
            })),
          },
        }).catch(() => undefined);
        return ok({
          plan_id: planId,
          started: selected.length,
          results,
          parent_execution_id: parentExecutionId,
          ok: allOk,
        });
      },
    },
    {
      name: "review_run",
      description:
        "Ejecuta code/security/qa en paralelo sobre una tarea verificada, con modelos de familia distinta al autor, y exige review_submit.",
      input: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
          task_id: { type: "string" },
          gate_run_id: { type: "string" },
          roles: { type: "array", items: { type: "string", enum: ["security", "code", "qa"] } },
          iteration: { type: "integer", minimum: 1, maximum: 3, default: 1 },
          timeout_minutes: { type: "integer", minimum: 1, maximum: 45, default: 15 },
          mode: { type: "string", enum: ["auto", "manual", "hybrid"] },
          confirmed: { type: "boolean", default: false },
        },
        required: ["plan_id", "task_id", "gate_run_id"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const planId = String(input.plan_id ?? "").trim();
        const taskId = String(input.task_id ?? "").trim();
        const gateRunId = String(input.gate_run_id ?? "").trim();
        if (!UUID_RE.test(planId) || !UUID_RE.test(taskId) || !UUID_RE.test(gateRunId)) {
          return fail("plan_id, task_id y gate_run_id deben ser UUID.");
        }
        const plan = await deps.planStore.getPlan(project.projectId, planId);
        if (!plan) return fail("El plan no existe.");
        const task = await deps.planStore.getPlanTask(planId, taskId);
        if (!task) return fail("La tarea no existe en el plan.");
        if (task.status !== "review") return fail("La tarea debe estar en review antes de lanzar revisores.");
        if (!task.worktree || !existsSync(task.worktree)) return fail("La tarea no tiene worktree.");
        if (!inside(worktreeRoot(project.name), task.worktree)) {
          return fail("El worktree de la tarea está fuera de la raíz permitida.");
        }
        const gate = await deps.db.getGateRun(gateRunId);
        if (!gate || gate.projectId !== project.projectId) return fail("El gate_run no existe en este proyecto.");
        if (gate.status !== "pass") return fail("El gate_run no está en verde.");
        if (gate.taskId !== task.taskId) return fail("El gate_run no corresponde a la tarea de esta subtarea.");
        const iteration = gate.iteration;
        const requestedRoles = Array.isArray(input.roles)
          ? input.roles.filter((role): role is string => typeof role === "string" && ["security", "code", "qa"].includes(role))
          : null;
        const roles = requestedRoles ?? (isSensitiveTask(task) ? ["security", "code", "qa"] : ["code", "qa"]);
        const timeout = (typeof input.timeout_minutes === "number" ? Math.round(input.timeout_minutes) : 15) * 60_000;
        const profile = await deps.db.getProfile(project.projectId);
        const mode = (
          typeof input.mode === "string" && ["auto", "manual", "hybrid"].includes(input.mode)
            ? input.mode
            : await activeMode(deps.mam)
        ) as WorkMode;
        const confirmed = input.confirmed === true;
        const implementerExecutions = await deps.mam.store.listExecutions({
          projectId: project.projectId,
          role: "implementer",
          taskId: task.taskId ?? undefined,
          limit: 5,
        });
        const parentExecutionId = implementerExecutions[0]?.id ?? null;

        type PlannedReview = {
          role: string;
          agent: string;
          selection: Awaited<ReturnType<typeof selectModel>>;
          executionId: string;
          budgetReserved: boolean;
          closed: boolean;
          reserveTokens: number;
          reserveCost: number;
        };
        const planned: PlannedReview[] = [];

        const closeOne = async (
          entry: PlannedReview,
          status: string,
          usage: ReviewUsage,
          error: string | null,
        ) => {
          if (entry.closed) return;
          entry.closed = true;
          const totals = usageTotals(usage);
          if (entry.budgetReserved) {
            await settleExecution(deps.mam, entry.executionId, totals.tokens, totals.costUsd).catch(() => undefined);
          } else {
            await releaseExecution(deps.mam, entry.executionId).catch(() => undefined);
          }
          await deps.mam.store.finishExecution(entry.executionId, {
            status,
            tokensInput: usage.tokens.input,
            tokensOutput: usage.tokens.output,
            tokensReasoning: usage.tokens.reasoning,
            tokensCacheRead: usage.tokens.cacheRead,
            tokensCacheWrite: usage.tokens.cacheWrite,
            costUsd: usage.costUsd,
            costSource: usage.costSource,
            error,
            gateRunId,
          }).catch(() => undefined);
        };

        for (const role of roles) {
          const agent = REVIEW_AGENTS[role]!;
          let selection;
          try {
            selection = await selectModel({
              mam: deps.mam,
              projectId: project.projectId,
              planId,
              task,
              role: role as "security" | "code" | "qa",
              mode,
              agentId: agent,
              authorModel: task.model,
              confirmed,
              attempt: iteration,
            });
          } catch (error) {
            for (const entry of planned) {
              await closeOne(entry, "released", emptyUsage(null), "Cancelado por error de selección.");
            }
            return fail(error instanceof Error ? error.message : String(error));
          }
          if (selection.requiresApproval) {
            for (const entry of planned) {
              await closeOne(entry, "released", emptyUsage(null), "Pendiente de aprobación.");
            }
            return fail(`El modo híbrido requiere aprobación para el revisor ${role}: ${selection.model} (${selection.reason}).`);
          }
          if (sameFamily(task.model, selection.model)) {
            for (const entry of planned) {
              await closeOne(entry, "released", emptyUsage(null), "Modelo de la misma familia.");
            }
            return fail(`El modelo ${role} (${selection.model}) es de la misma familia que el autor (${task.model}).`);
          }
          const reserveTokens = estimateReserveTokens(task.difficulty, selection.maxTokens);
          const reserveCost = await estimateReserveCost(
            deps.mam.store,
            selection.providerId,
            selection.modelId,
            reserveTokens,
            selection.maxCostUsd,
          );
          let executionId: string;
          try {
            executionId = await deps.mam.store.startExecution({
              projectId: project.projectId,
              phase: task.phase,
              parentExecutionId,
              profileId: selection.profileId,
              agentId: agent,
              providerId: selection.providerId,
              modelId: selection.modelId,
              role,
              taskId: task.taskId,
              planId,
              mode,
              selectionReason: selection.reason,
              attempt: iteration,
              toolVersions: toolVersions(deps.runtime),
              gateRunId,
              priceVersion: await deps.mam.store.priceVersion(),
              metadata: {
                review_role: role,
                iteration,
                plan_task_id: taskId,
                reserved_tokens: reserveTokens,
                reserved_cost_usd: reserveCost,
              },
            });
          } catch (error) {
            for (const entry of planned) {
              await closeOne(entry, "released", emptyUsage(null), "Error de execution log.");
            }
            return fail(error instanceof Error ? error.message : String(error));
          }
          const entry: PlannedReview = {
            role,
            agent,
            selection,
            executionId,
            budgetReserved: false,
            closed: false,
            reserveTokens,
            reserveCost,
          };
          planned.push(entry);
          try {
            const reservation = await reserveExecution(deps.mam, {
              executionId,
              projectId: project.projectId,
              planId,
              phase: task.phase,
              taskId: task.taskId,
              tokens: reserveTokens,
              costUsd: reserveCost,
            });
            if (!reservation.ok) {
              const message = `Presupuesto insuficiente para el revisor ${role}: ${reserveTokens} tokens / ${reserveCost.toFixed(4)} USD.`;
              for (const item of planned) {
                await closeOne(item, "budget_rejected", emptyUsage(null), message);
              }
              return fail(message);
            }
            entry.budgetReserved = true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            for (const item of planned) {
              await closeOne(item, "budget_error", emptyUsage(null), message);
            }
            return fail(message);
          }
        }

        const route = Object.fromEntries(
          planned.map((entry) => [entry.role, entry.selection.model]),
        ) as Record<string, string>;

        const base = await resolveBaseBranch(task.worktree, profile);
        const filesResult = await runCommand(`git diff --name-only ${shellQuote(base)}...HEAD --`, task.worktree, 20_000);
        const diffResult = await runCommand(`git diff ${shellQuote(base)}...HEAD --`, task.worktree, 30_000);
        const changed = filesResult.exitCode === 0 ? filesResult.stdout.trim() : "";
        const diffFull = diffResult.exitCode === 0 ? diffResult.stdout : "";
        const diffTruncated = diffFull.length > 60_000;
        const diff = diffFull.slice(0, 60_000);
        const gateDetails = (Array.isArray(gate.gates) ? gate.gates : [])
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .filter((item) => ["test", "security"].includes(String(item.gate)))
          .map((item) => `${String(item.gate)}: ${String(item.status)} — ${String(item.evidence ?? "")}`)
          .join("\n");

        let sessions: Array<Record<string, unknown>> = [];
        try {
          sessions = await Promise.all(planned.map(async (entry) => {
            const session = await deps.runtime.session.create({
              parentID: String(context.sessionID),
              title: `${entry.role} · ${task.title}`.slice(0, 120),
              agent: entry.agent,
              model: parseModel(entry.selection.model),
              location: { directory: task.worktree },
            });
            const sessionID = String(session.id ?? "");
            if (!sessionID) throw new Error(`No se pudo crear la sesión del revisor ${entry.role}.`);
            await deps.mam.store.setExecutionSession(entry.executionId, sessionID);
            const prompt = [
              `Revisa la tarea "${task.title}" de la subtarea.`,
              `task_id: ${task.taskId}`,
              `gate_run_id: ${gateRunId}`,
              `iteration: ${iteration}`,
              `model: ${entry.selection.model}`,
              `Criterio de aceptación: ${task.acceptanceCriteria}`,
              `Worktree: ${task.worktree}`,
              `Archivos asignados: ${task.filesOwned.join(", ")}`,
              `Archivos cambiados (rutas absolutas): ${changed.split(/\r?\n/).filter(Boolean).map((file) => `${task.worktree}/${file}`).join(", ") || "(sin diff)"}`,
              `Archivos cambiados: ${changed || "(sin diff)"}`,
              `Gate: ${gate.summary ?? "sin resumen"}`,
              gateDetails || "(sin evidencia de test/security)",
              diffTruncated ? "Aviso: el diff se truncó a 60 KB; revisa los archivos grandes por separado." : "",
              "Diff:",
              "```diff",
              diff || "(sin diff)",
              "```",
              `Eres el revisor ${entry.role}. No edites archivos. Usa exactamente el modelo ${entry.selection.model}. Al terminar, llama a review_submit con role="${entry.role}", model="${entry.selection.model}", verdict, findings, summary, task_id, gate_run_id e iteration.`,
            ].join("\n");
            await deps.runtime.session.prompt({ sessionID, text: prompt });
            await waitWithTimeout(deps.runtime, sessionID, timeout);
            const snapshot = await deps.usage.getSessionUsage(sessionID);
            const price = snapshot
              ? await deps.usage.getModelPrice(
                  snapshot.model || entry.selection.model,
                  snapshot.tokens.input + snapshot.tokens.cacheRead,
                )
              : null;
            const usage = snapshot ? captureUsage(snapshot, price, sessionID) : emptyUsage(sessionID);
            const totals = usageTotals(usage);
            const exceeded =
              (entry.selection.maxTokens !== null && totals.tokens > entry.selection.maxTokens) ||
              (entry.selection.maxCostUsd !== null && totals.costUsd > entry.selection.maxCostUsd);
            await closeOne(
              entry,
              exceeded ? "budget_exceeded" : "done",
              usage,
              exceeded ? "Presupuesto excedido." : null,
            );
            return {
              role: entry.role,
              model: entry.selection.model,
              session_id: sessionID,
              usage,
              budget_exceeded: exceeded,
              max_tokens: entry.selection.maxTokens,
              max_cost_usd: entry.selection.maxCostUsd,
            };
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const entry of planned) {
            await closeOne(entry, "failed", emptyUsage(null), message);
          }
          return fail(message);
        }

        const exceededSessions = sessions.filter((session) => session.budget_exceeded === true);
        if (exceededSessions.length > 0) {
          const message = `Presupuesto excedido en revisiones: ${exceededSessions
            .map((session) => String(session.role))
            .join(", ")}.`;
          await deps.planStore.updatePlanTask(planId, taskId, {
            status: "blocked",
            reviewRoute: route,
            result: { ...task.result, reviews: [], review_sessions: sessions },
            lastError: message,
          });
          return fail(message);
        }

        const latest = await deps.db.getReviewsForGate(task.taskId!, gateRunId, iteration);
        const reviews = [];
        for (const role of roles) {
          const review = latest.find((item) => item.role === role);
          if (!review) return fail(`El revisor ${role} no llamó a review_submit.`);
          if (sameFamily(task.model, review.model)) return fail(`El revisor ${role} usó un modelo de la misma familia que el autor.`);
          const plannedReview = planned.find((entry) => entry.role === role);
          if (plannedReview && review.model !== plannedReview.selection.model) {
            return fail(
              `El revisor ${role} reportó ${review.model}, pero el modelo bloqueado era ${plannedReview.selection.model}.`,
            );
          }
          reviews.push({
            role,
            id: review.id,
            model: review.model,
            verdict: review.verdict,
            open_blocking: review.openBlocking,
            summary: review.summary,
          });
        }
        const approved = reviews.every((review) => review.verdict === "approved" && review.open_blocking === 0);
        await deps.planStore.updatePlanTask(planId, taskId, {
          status: approved ? "review" : "blocked",
          reviewRoute: route,
          result: { ...task.result, reviews, review_sessions: sessions },
          lastError: approved ? null : "Revisión con cambios requeridos.",
        });
        return ok({
          plan_id: planId,
          task_id: taskId,
          approved,
          reviews,
          sessions,
          mode,
          route,
        });
      },
    },
    {
      name: "subtask_integrate",
      description:
        "Fusiona la rama de una tarea revisada en factory/integration/<proyecto>. Nunca fusiona en main/master/develop.",
      input: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
          task_id: { type: "string" },
        },
        required: ["plan_id", "task_id"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const planId = String(input.plan_id ?? "").trim();
        const taskId = String(input.task_id ?? "").trim();
        if (!UUID_RE.test(planId) || !UUID_RE.test(taskId)) return fail("plan_id y task_id deben ser UUID.");
        const plan = await deps.planStore.getPlan(project.projectId, planId);
        const task = await deps.planStore.getPlanTask(planId, taskId);
        if (!plan || !task) return fail("Plan o tarea no encontrados.");
        if (task.status !== "review") return fail("La tarea debe estar en review (gates y revisores aprobados) antes de integrarse.");
        if (!task.worktree || !task.branch || !task.taskId) return fail("La tarea no tiene worktree, rama o tarea vinculada.");
        if (!inside(worktreeRoot(project.name), task.worktree)) {
          return fail("El worktree de la tarea está fuera de la raíz permitida.");
        }
        if (!isSafeBranchName(task.branch)) return fail("La rama de la tarea no es segura.");
        const gate = await deps.db.getLatestGateRun(project.projectId, task.taskId);
        if (!gate || gate.status !== "pass") return fail("No hay gate_run en verde para la tarea.");
        const reviews = await deps.db.getReviewsForGate(task.taskId, gate.id, gate.iteration);
        const required = ["code", "qa", ...(isSensitiveTask(task) ? ["security"] : [])];
        for (const role of required) {
          const review = reviews.find((item) => item.role === role);
          if (!review || review.verdict !== "approved" || review.openBlocking > 0) {
            return fail(`Falta la revisión ${role} aprobada.`);
          }
        }
        const dirty = await runCommand("git status --porcelain", task.worktree, 20_000);
        if (dirty.exitCode !== 0 || dirty.stdout.trim()) return fail("El worktree de la tarea tiene cambios sin commit.");
        const profile = await deps.db.getProfile(project.projectId);
        const base = await resolveBaseBranch(task.worktree, profile);
        const files = await changedFiles(task.worktree, base);
        const outside = filesOutsideOwned(files, task.filesOwned);
        if (outside.length > 0) return fail(`La rama toca archivos fuera de files_owned: ${outside.join(", ")}.`);
        const mainStatus = await runCommand("git status --porcelain", project.directory, 20_000);
        if (mainStatus.exitCode !== 0 || mainStatus.stdout.trim()) return fail("El checkout principal tiene cambios sin commit; no se integra.");
        const integration = `factory/integration/${slugify(project.name)}`;
        const current = await runCommand("git branch --show-current", project.directory, 15_000);
        if (current.exitCode !== 0) return fail("No se pudo leer la rama principal.");
        if (current.stdout.trim() !== integration) {
          const exists = await runCommand(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${integration}`)}`, project.directory, 15_000);
          const command = exists.exitCode === 0
            ? `git switch ${shellQuote(integration)}`
            : `git switch -c ${shellQuote(integration)} ${shellQuote(base)}`;
          const switched = await git(deps, context, command, project.directory, 30_000);
          if (switched.exitCode !== 0) return fail(`No se pudo cambiar a ${integration}: ${tail(switched.stderr || switched.stdout || "", 500)}`);
        }
        const merge = await git(
          deps,
          context,
          `git merge --no-ff ${shellQuote(task.branch)} -m ${shellQuote(`merge: ${task.title}`)}`,
          project.directory,
          120_000,
        );
        if (merge.exitCode !== 0) {
          await runCommand("git merge --abort", project.directory, 30_000);
          return fail(`Conflicto al fusionar ${task.branch}; se abortó. ${tail(merge.stderr || merge.stdout, 800)}`);
        }
        const commit = await runCommand("git rev-parse --short HEAD", project.directory, 15_000);
        await deps.planStore.updatePlanTask(planId, taskId, {
          status: "merged",
          finishedAt: new Date().toISOString(),
          result: { ...task.result, integration_branch: integration, integration_commit: commit.stdout.trim() },
        });
        return ok({
          integrated: true,
          integration_branch: integration,
          commit: commit.exitCode === 0 ? commit.stdout.trim() : null,
          files,
        });
      },
    },
  ];
}
