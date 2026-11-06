/**
 * Tools del tablero de tareas.
 *
 * Qué hacen: crean, actualizan y listan tareas por proyecto en la tabla `tasks`
 * de PostgreSQL. Cada tarea tiene título, criterio de aceptación verificable,
 * estado, resultado y timestamps.
 *
 * Qué acceden: la tabla `tasks`. No leen archivos ni ejecutan comandos.
 */

import type { FactoryDb, ProjectRef, TaskStatus } from "./db.js";
import { TASK_STATUSES } from "./db.js";
import { fail, looksLikeSecret, ok, type ToolDef } from "./types.js";

export interface TaskToolsDeps {
  db: FactoryDb;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asStatus(value: unknown): TaskStatus | undefined {
  return typeof value === "string" && (TASK_STATUSES as string[]).includes(value)
    ? (value as TaskStatus)
    : undefined;
}

export function createTaskTools(deps: TaskToolsDeps): ToolDef[] {
  return [
    {
      name: "task_create",
      description: "Crea una tarea pequeña con criterio de aceptación verificable.",
      input: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 3, maxLength: 200 },
          acceptance_criteria: {
            type: "string",
            minLength: 3,
            maxLength: 4_000,
            description: "Cómo se comprobará que está terminada.",
          },
          status: {
            type: "string",
            enum: TASK_STATUSES,
            default: "pending",
          },
        },
        required: ["title", "acceptance_criteria"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const title = String(input.title ?? "").trim();
        const acceptance = String(input.acceptance_criteria ?? "").trim();
        if (title.length < 3) return fail("El título debe tener al menos 3 caracteres.");
        if (acceptance.length < 3) return fail("El criterio de aceptación debe tener al menos 3 caracteres.");
        if (looksLikeSecret(`${title}\n${acceptance}`)) {
          return fail("La tarea parece contener un secreto. No se guardó.");
        }

        const project = await deps.resolveProject(String(context.sessionID));
        const task = await deps.db.createTask({
          projectId: project.projectId,
          projectPath: project.directory,
          title: title.slice(0, 200),
          acceptanceCriteria: acceptance.slice(0, 4_000),
          status: asStatus(input.status) ?? "pending",
          result: null,
        });
        return ok({ created: true, task });
      },
    },
    {
      name: "task_update",
      description: "Actualiza estado, resultado o criterio de una tarea del proyecto.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "UUID de la tarea." },
          status: { type: "string", enum: TASK_STATUSES },
          result: { type: "string", maxLength: 8_000 },
          acceptance_criteria: { type: "string", minLength: 3, maxLength: 4_000 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const id = String(input.id ?? "").trim();
        if (!UUID_RE.test(id)) return fail("El id de la tarea no es un UUID válido.");
        if (
          input.status === undefined &&
          input.result === undefined &&
          input.acceptance_criteria === undefined
        ) {
          return fail("Indica al menos un campo a actualizar: status, result o acceptance_criteria.");
        }

        const resultText =
          input.result === undefined
            ? undefined
            : input.result === null
              ? null
              : String(input.result).slice(0, 8_000);
        const acceptanceText =
          input.acceptance_criteria === undefined
            ? undefined
            : String(input.acceptance_criteria).trim().slice(0, 4_000);
        if (looksLikeSecret(`${resultText ?? ""}\n${acceptanceText ?? ""}`)) {
          return fail("La actualización parece contener un secreto. No se guardó.");
        }

        const project = await deps.resolveProject(String(context.sessionID));
        const status = input.status === undefined ? undefined : asStatus(input.status);
        if (input.status !== undefined && !status) {
          return fail(`Estado inválido. Valores permitidos: ${TASK_STATUSES.join(", ")}.`);
        }
        if (status === "done") {
          return fail("No marques done con task_update. Usa task_close con gate_run, revisiones, evidencia y memoria.");
        }

        const task = await deps.db.updateTask(project.projectId, id, {
          status,
          result: resultText,
          acceptanceCriteria: acceptanceText,
        });
        if (!task) return fail("No existe una tarea con ese id en el proyecto actual.");
        return ok({ updated: true, task });
      },
    },
    {
      name: "task_list",
      description: "Lista las tareas del proyecto, opcionalmente por estado.",
      input: {
        type: "object",
        properties: {
          status: { type: "string", enum: TASK_STATUSES },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const status = asStatus(input.status);
        if (input.status !== undefined && !status) {
          return fail(`Estado inválido. Valores permitidos: ${TASK_STATUSES.join(", ")}.`);
        }
        const limit =
          typeof input.limit === "number"
            ? Math.min(Math.max(Math.round(input.limit), 1), 100)
            : 20;
        const tasks = await deps.db.listTasks(project.projectId, { status, limit });
        return ok({ count: tasks.length, project, tasks });
      },
    },
  ];
}
