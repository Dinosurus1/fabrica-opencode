/**
 * Planificador determinista del plan por fases.
 *
 * Qué hace: valida el DAG, detecta ciclos, comprueba criterios/archivos,
 * identifica tareas fáciles sobre superficie sensible y calcula olas de
 * ejecución respetando dependencias, archivos compartidos y concurrencia.
 *
 * No accede a disco, base de datos ni modelos.
 */

import { anyGlobsOverlap, isSharedTask, isSensitiveTask } from "./paths.js";

export type Difficulty = "easy" | "medium" | "hard";
export type Assignee = "orchestrator" | "implementer";

export interface PlanTaskLike {
  id: string;
  phase: number;
  phaseName?: string | null;
  title: string;
  description?: string;
  acceptanceCriteria: string;
  difficulty: Difficulty;
  difficultyReason?: string;
  assignee: Assignee;
  model: string;
  filesOwned: string[];
  riskFlags?: string[];
  parallelizable: boolean;
  dependsOn: string[];
  status: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  taskIds: string[];
  severity: "error" | "warning";
}

export interface PlanValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  waves: Array<{ index: number; taskIds: string[] }>;
}

export interface ReadyWave {
  wave: PlanTaskLike[];
  deferred: Array<{ taskId: string; reason: string }>;
  blocked: Array<{ taskId: string; reason: string }>;
}

const DONE = new Set(["done", "merged"]);
const TERMINAL = new Set(["done", "merged", "cancelled"]);
const ACTIVE = new Set(["running", "review"]);
const CANDIDATE = new Set(["pending", "ready"]);

function byId(tasks: readonly PlanTaskLike[]): Map<string, PlanTaskLike> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function titleOf(tasks: Map<string, PlanTaskLike>, id: string): string {
  return tasks.get(id)?.title ?? id.slice(0, 8);
}

/** Devuelve el primer ciclo encontrado, como lista de IDs. */
export function findCycle(tasks: readonly PlanTaskLike[]): string[] | null {
  const map = byId(tasks);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id) ?? 0;
    if (current === 1) {
      const start = stack.indexOf(id);
      return start >= 0 ? [...stack.slice(start), id] : [id];
    }
    if (current === 2) return null;
    state.set(id, 1);
    stack.push(id);
    const task = map.get(id);
    for (const dependency of task?.dependsOn ?? []) {
      if (!map.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

function reachableFrom(start: string, tasks: Map<string, PlanTaskLike>, seen = new Set<string>()): Set<string> {
  const task = tasks.get(start);
  if (!task) return seen;
  for (const dependency of task.dependsOn) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    reachableFrom(dependency, tasks, seen);
  }
  return seen;
}

function hasDependencyPath(from: string, to: string, tasks: Map<string, PlanTaskLike>): boolean {
  return reachableFrom(from, tasks).has(to);
}

export function topologicalWaves(tasks: readonly PlanTaskLike[]): Array<{ index: number; taskIds: string[] }> {
  const map = byId(tasks);
  const remaining = new Set(tasks.map((task) => task.id));
  const placed = new Set<string>();
  const waves: Array<{ index: number; taskIds: string[] }> = [];
  let guard = 0;

  while (remaining.size > 0 && guard < tasks.length + 2) {
    guard += 1;
    const layer = [...remaining].filter((id) => {
      const task = map.get(id);
      if (!task) return true;
      return task.dependsOn.every((dependency) => !remaining.has(dependency) || placed.has(dependency));
    });
    if (layer.length === 0) break;
    for (const id of layer) {
      remaining.delete(id);
      placed.add(id);
    }
    waves.push({ index: waves.length, taskIds: layer });
  }

  if (remaining.size > 0) {
    waves.push({ index: waves.length, taskIds: [...remaining] });
  }
  return waves;
}

export function validatePlan(tasks: readonly PlanTaskLike[]): PlanValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const map = byId(tasks);
  const seen = new Set<string>();

  for (const task of tasks) {
    if (!task.id.trim()) {
      errors.push({ code: "task.id.empty", message: "Hay una tarea sin id.", taskIds: [], severity: "error" });
      continue;
    }
    if (seen.has(task.id)) {
      errors.push({ code: "task.id.duplicate", message: `ID duplicado: ${task.id}.`, taskIds: [task.id], severity: "error" });
    }
    seen.add(task.id);
    if (!task.title.trim()) {
      errors.push({ code: "task.title.empty", message: `La tarea ${task.id} no tiene título.`, taskIds: [task.id], severity: "error" });
    }
    if (!task.acceptanceCriteria.trim()) {
      errors.push({ code: "task.acceptance.empty", message: `La tarea "${task.title}" no tiene criterio de aceptación.`, taskIds: [task.id], severity: "error" });
    }
    if (!task.difficultyReason?.trim()) {
      warnings.push({ code: "task.difficulty_reason.empty", message: `La tarea "${task.title}" no explica la dificultad.`, taskIds: [task.id], severity: "warning" });
    }
    if (!task.model.trim()) {
      errors.push({ code: "task.model.empty", message: `La tarea "${task.title}" no tiene modelo asignado.`, taskIds: [task.id], severity: "error" });
    }
    if (task.filesOwned.length === 0) {
      errors.push({ code: "task.files.empty", message: `La tarea "${task.title}" no tiene archivos asignados.`, taskIds: [task.id], severity: "error" });
    }
    if (task.phase < 0) {
      errors.push({ code: "task.phase.invalid", message: `La tarea "${task.title}" tiene fase negativa.`, taskIds: [task.id], severity: "error" });
    }
    if (task.assignee === "implementer" && task.difficulty === "hard") {
      errors.push({
        code: "task.hard_delegated",
        message: `La tarea "${task.title}" es difícil y está asignada a implementer; debe quedar en el orquestador.`,
        taskIds: [task.id],
        severity: "error",
      });
    }
    if (task.assignee === "implementer" && task.difficulty === "medium") {
      warnings.push({
        code: "task.medium_delegated",
        message: `La tarea "${task.title}" es media y está delegada; revisa que no sea ambigua.`,
        taskIds: [task.id],
        severity: "warning",
      });
    }
    if (task.assignee === "implementer" && isSensitiveTask(task)) {
      errors.push({
        code: "task.easy_sensitive_delegated",
        message: `La tarea "${task.title}" toca superficie sensible (${(task.riskFlags ?? []).join(", ") || "detectada"}) y no puede delegarse al implementer.`,
        taskIds: [task.id],
        severity: "error",
      });
    }
    if (task.parallelizable && isSharedTask(task.filesOwned)) {
      errors.push({
        code: "task.shared_parallel",
        message: `La tarea "${task.title}" toca archivos compartidos; marca parallelizable=false para serializarla.`,
        taskIds: [task.id],
        severity: "error",
      });
    }
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        errors.push({ code: "task.self_dependency", message: `La tarea "${task.title}" depende de sí misma.`, taskIds: [task.id], severity: "error" });
      } else if (!map.has(dependency)) {
        errors.push({
          code: "task.dependency.missing",
          message: `La tarea "${task.title}" depende de ${dependency}, que no existe en el plan.`,
          taskIds: [task.id],
          severity: "error",
        });
      } else {
        const dependencyTask = map.get(dependency)!;
        if (dependencyTask.phase > task.phase) {
          warnings.push({
            code: "task.dependency.phase_order",
            message: `La tarea "${task.title}" (fase ${task.phase}) depende de "${dependencyTask.title}" (fase ${dependencyTask.phase}); revisa el orden.`,
            taskIds: [task.id, dependencyTask.id],
            severity: "warning",
          });
        }
      }
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) {
    errors.push({
      code: "plan.cycle",
      message: `Ciclo de dependencias: ${cycle.map((id) => titleOf(map, id)).join(" → ")}.`,
      taskIds: cycle,
      severity: "error",
    });
  }

  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    const left = tasks[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const right = tasks[rightIndex]!;
      if (!left.parallelizable || !right.parallelizable) continue;
      if (hasDependencyPath(left.id, right.id, map) || hasDependencyPath(right.id, left.id, map)) continue;
      if (!anyGlobsOverlap(left.filesOwned, right.filesOwned)) continue;
      errors.push({
        code: "plan.files_overlap",
        message: `"${left.title}" y "${right.title}" pueden ejecutarse en paralelo y solapan archivos. Añade una dependencia o marca una como serializable.`,
        taskIds: [left.id, right.id],
        severity: "error",
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    waves: topologicalWaves(tasks),
  };
}

/**
 * Calcula la siguiente ola ejecutable. No cambia estados; el ejecutor los marca.
 * `activeIds` permite considerar tareas que ya están en otro proceso.
 */
export function nextWave(
  tasks: readonly PlanTaskLike[],
  activeIds: readonly string[] = [],
  maxConcurrency = 3,
): ReadyWave {
  const map = byId(tasks);
  const active = new Set(activeIds);
  const activeTasks = [...active].map((id) => map.get(id)).filter((task): task is PlanTaskLike => Boolean(task));
  const blocked: Array<{ taskId: string; reason: string }> = [];
  const deferred: Array<{ taskId: string; reason: string }> = [];
  const candidates: PlanTaskLike[] = [];

  for (const task of tasks) {
    if (!CANDIDATE.has(task.status)) continue;
    if (active.has(task.id)) continue;
    const unmet = task.dependsOn.filter((dependency) => {
      const dependencyTask = map.get(dependency);
      return !dependencyTask || !DONE.has(dependencyTask.status);
    });
    if (unmet.length > 0) {
      const failed = unmet.find((id) => {
        const dependencyTask = map.get(id);
        return dependencyTask && ["failed", "escalated", "blocked", "cancelled"].includes(dependencyTask.status);
      });
      if (failed) {
        blocked.push({ taskId: task.id, reason: `dependencia ${titleOf(map, failed)} no está completada` });
      } else {
        deferred.push({ taskId: task.id, reason: "esperando dependencias" });
      }
      continue;
    }
    candidates.push(task);
  }

  candidates.sort((left, right) => left.phase - right.phase || left.title.localeCompare(right.title));
  const wave: PlanTaskLike[] = [];
  const locked = [...activeTasks];

  for (const task of candidates) {
    if (wave.length >= maxConcurrency) {
      deferred.push({ taskId: task.id, reason: "máximo de concurrencia" });
      continue;
    }
    if (isSharedTask(task.filesOwned)) {
      if (locked.length > 0 || wave.length > 0) {
        deferred.push({ taskId: task.id, reason: "archivo compartido; se serializa" });
        continue;
      }
      wave.push(task);
      locked.push(task);
      continue;
    }
    const collision = locked.find((other) => anyGlobsOverlap(task.filesOwned, other.filesOwned));
    if (collision) {
      deferred.push({ taskId: task.id, reason: `solapa archivos con ${collision.title}` });
      continue;
    }
    wave.push(task);
    locked.push(task);
  }

  return { wave, deferred, blocked };
}

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export function isActive(status: string): boolean {
  return ACTIVE.has(status);
}
