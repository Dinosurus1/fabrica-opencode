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
import type { FactoryDb, FactoryProfile, ProjectRef } from "./db.js";
import type { PlanStore, PlanTaskRecord, PlanRecord } from "./plan-db.js";
import { isSensitiveTask, filesOutsideOwned, isSafeBranchName, matchesGlob, slugify, worktreeRoot } from "./paths.js";
import { routeReviewMap, sameFamily } from "./routing.js";
import { runCommand, shellQuote, tail } from "./exec.js";
import { captureUsage, emptyUsage, type SessionUsageSnapshot, type UsageDeps } from "./usage.js";
import { fail, ok, type ToolDef } from "./types.js";

export interface SubtaskToolsDeps {
  db: FactoryDb;
  planStore: PlanStore;
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
): Promise<Record<string, unknown>> {
  const prepared = await getWorktree(deps, project, profile, plan, task, context);
  if ("error" in prepared) {
    await deps.planStore.updatePlanTask(plan.id, task.id, { status: "failed", lastError: prepared.error, finishedAt: new Date().toISOString() });
    return { task_id: task.id, status: "failed", error: prepared.error };
  }
  const { worktree, branch } = prepared;
  const attempts = task.attempts + 1;
  const route = routeReviewMap(task.model);
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
  await deps.db.setTaskAuthorModel(project.projectId, taskRow.id, task.model);
  await deps.planStore.updatePlanTask(plan.id, task.id, {
    taskId: taskRow.id,
    worktree,
    branch,
    attempts,
    status: "running",
    startedAt: new Date().toISOString(),
    reviewRoute: route,
    lastError: null,
  });
  const run = await deps.planStore.createSubtaskRun({
    planId: plan.id,
    planTaskId: task.id,
    taskId: taskRow.id,
    sessionId: null,
    worktree,
    branch,
    model: task.model,
    status: "running",
    summary: null,
    result: {},
    usage: emptyUsage(null),
  });

  const prompt = [
    `Implementa esta tarea en el worktree asignado.`,
    `Proyecto: ${project.directory}`,
    `Worktree: ${worktree}`,
    `Rama: ${branch}`,
    `Tarea: ${task.title}`,
    `Descripción: ${task.description}`,
    `Criterio de aceptación: ${task.acceptanceCriteria}`,
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
      model: parseModel(task.model),
      location: { directory: worktree },
      permissions: implementerPermissions(worktree),
    });
    sessionID = String(session.id ?? "");
    if (!sessionID) throw new Error("No se pudo crear la sesión del implementer.");
    await deps.planStore.updatePlanTask(plan.id, task.id, { sessionId: sessionID });
    await deps.planStore.updateSubtaskRun(run.id, { sessionId: sessionID });
    await deps.runtime.session.prompt({ sessionID, text: prompt });
    await waitWithTimeout(deps.runtime, sessionID, Math.max(1, timeoutMinutes) * 60_000);
    const messages = await deps.runtime.session.context({ sessionID });
    const summary = extractFinalText(messages);
    const snapshot = (await deps.usage.getSessionUsage(sessionID)) as SessionUsageSnapshot | null;
    const price = snapshot
      ? await deps.usage.getModelPrice(snapshot.model || task.model, snapshot.tokens.input + snapshot.tokens.cacheRead)
      : null;
    const usage = snapshot ? captureUsage(snapshot, price, sessionID) : emptyUsage(sessionID);

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
    return { task_id: task.id, status: "review", session_id: sessionID, worktree, branch, files, commit, summary: summary.slice(0, 2_000) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const escalate = attempts >= 2;
    const snapshot = sessionID ? await deps.usage.getSessionUsage(sessionID).catch(() => null) : null;
    const price = snapshot
      ? await deps.usage.getModelPrice(snapshot.model || task.model, snapshot.tokens.input + snapshot.tokens.cacheRead)
      : null;
    const usage = snapshot ? captureUsage(snapshot, price, sessionID || null) : emptyUsage(sessionID || null);
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
        const timeout = typeof input.timeout_minutes === "number" ? Math.round(input.timeout_minutes) : 20;
        const results = await Promise.all(
          selected.map(async (task) => {
            try {
              return await runOne(deps, project, profile, plan, task, {
                sessionID: String(context.sessionID),
                agent: context.agent,
                messageID: String(context.messageID),
                id: String(context.id),
              }, timeout);
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
        return ok({
          plan_id: planId,
          started: selected.length,
          results,
          ok: results.every((result) => result.status === "review"),
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
        const route = routeReviewMap(task.model);
        for (const role of roles) {
          const model = route[role as "security" | "code" | "qa"];
          if (sameFamily(task.model, model)) {
            return fail(`El modelo ${role} (${model}) es de la misma familia que el autor (${task.model}).`);
          }
        }

        const base = await resolveBaseBranch(task.worktree, await deps.db.getProfile(project.projectId));
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

        const sessions = await Promise.all(roles.map(async (role) => {
          const agent = REVIEW_AGENTS[role]!;
          const model = route[role as "security" | "code" | "qa"];
          const session = await deps.runtime.session.create({
            parentID: String(context.sessionID),
            title: `${role} · ${task.title}`.slice(0, 120),
            agent,
            model: parseModel(model),
            location: { directory: task.worktree },
          });
          const sessionID = String(session.id ?? "");
          const prompt = [
            `Revisa la tarea "${task.title}" de la subtarea.`,
            `task_id: ${task.taskId}`,
            `gate_run_id: ${gateRunId}`,
            `iteration: ${iteration}`,
            `model: ${model}`,
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
            `Eres el revisor ${role}. No edites archivos. Al terminar, llama a review_submit con role="${role}", model="${model}", verdict, findings, summary, task_id, gate_run_id e iteration.`,
          ].join("\n");
          if (!sessionID) throw new Error(`No se pudo crear la sesión del revisor ${role}.`);
          await deps.runtime.session.prompt({ sessionID, text: prompt });
          await waitWithTimeout(deps.runtime, sessionID, timeout);
          return { role, model, sessionID };
        }));

        const latest = await deps.db.getReviewsForGate(task.taskId!, gateRunId, iteration);
        const reviews = [];
        for (const role of roles) {
          const review = latest.find((item) => item.role === role);
          if (!review) return fail(`El revisor ${role} no llamó a review_submit.`);
          if (sameFamily(task.model, review.model)) return fail(`El revisor ${role} usó un modelo de la misma familia que el autor.`);
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
