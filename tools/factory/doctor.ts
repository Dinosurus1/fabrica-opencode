/**
 * Tool factory_doctor.
 *
 * Qué hace: diagnostica la instalación de la fábrica sin modificar nada.
 * Comprueba PostgreSQL, tablas/columnas, migraciones, escáneres disponibles,
 * modelos y agentes esperados, plugin de memoria y tools registradas.
 *
 * Qué accede: la base de datos de la fábrica, el PATH y los metadatos que expone
 * OpenCode (agentes, modelos, plugins y tools). No imprime cadenas de conexión
 * ni secretos. Los comandos `--version` son de solo lectura.
 */

import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryDb, ProjectRef } from "./db.js";
import type { MamRuntime } from "./mam.js";
import type { PlanStore } from "./plan-db.js";
import { redact, runCommand, shellQuote, tail } from "./exec.js";
import { worktreeRoot } from "./paths.js";
import { ok, type ToolDef } from "./types.js";

export interface DoctorDeps {
  db: FactoryDb;
  mam?: MamRuntime;
  planStore?: PlanStore;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
  diagnostics: {
    listAgents: () => Promise<unknown>;
    listModels: () => Promise<unknown>;
    listPlugins: () => Promise<unknown>;
    listTools: () => Promise<unknown>;
  };
}

const EXPECTED_AGENTS: Record<string, string> = {
  factory: "opencode-go/deepseek-v4.1-flash",
  "plan-reviewer": "opencode-go/claude-haiku-5-5",
  implementer: "opencode-go/glm-5.3-flash",
  "security-reviewer": "opencode-go/glm-5.3-flash",
  "code-reviewer": "opencode-go/claude-haiku-5-5",
  "qa-engineer": "opencode-go/minimax-m3",
  helper: "opencode-go/glm-5.3-flash",
  "product-analyst": "opencode-go/glm-5.3",
  architect: "opencode-go/glm-5.3",
  "tech-writer": "opencode-go/glm-5.3-flash",
  "devops-engineer": "opencode-go/glm-5.3",
};

const EXPECTED_TOOLS = [
  "project_detect",
  "project_profile_get",
  "project_profile_set",
  "task_create",
  "task_update",
  "task_list",
  "run_checks",
  "security_scan",
  "git_branch",
  "git_commit",
  "run_gates",
  "quality_policy_set",
  "review_submit",
  "task_close",
  "plan_create",
  "plan_update",
  "plan_status",
  "plan_validate",
  "plan_review",
  "subtask_run",
  "review_run",
  "subtask_integrate",
  "phase_close",
  "plan_resume",
  "model_catalog_sync",
  "model_catalog_list",
  "agent_catalog_list",
  "model_profile_list",
  "model_profile_get",
  "model_profile_set",
  "model_profile_validate",
  "model_profile_delete",
  "model_profile_apply",
  "mam_status",
  "budget_list",
  "budget_set",
  "executions_list",
  "model_history",
  "factory_agents_get",
  "factory_agents_propose",
  "factory_agents_select",
  "factory_agents_apply",
  "factory_agents_check",
  "factory_doctor",
];

const EXPECTED_SCANNERS = ["semgrep", "gitleaks", "osv-scanner", "trivy"];

function findExecutable(name: string): string | null {
  const path = process.env.PATH ?? "";
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    try {
      accessSync(join(directory, name), constants.X_OK);
      return join(directory, name);
    } catch {
      // Sigue buscando.
    }
  }
  return null;
}

function asData(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return ((value as { data: unknown[] }).data).filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
    );
  }
  return [];
}

function firstLine(value: string): string {
  return redact(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]?.slice(0, 160) ?? "";
}

export function createDoctorTools(deps: DoctorDeps): ToolDef[] {
  return [
    {
      name: "factory_doctor",
      description:
        "Diagnostica PostgreSQL, tablas/migraciones, escáneres, modelos/agentes, plugin de memoria y tools.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const checks: Array<{ name: string; status: "ok" | "warn" | "error"; detail: string }> = [];
        const add = (name: string, status: "ok" | "warn" | "error", detail: string) => {
          checks.push({ name, status, detail: redact(detail).slice(0, 600) });
        };

        let dbOk = false;
        try {
          dbOk = await deps.db.health();
          add("postgres", dbOk ? "ok" : "error", dbOk ? "conexión y SELECT 1 correctos" : "SELECT 1 no devolvió 1");
        } catch (error) {
          add("postgres", "error", error instanceof Error ? error.message : String(error));
        }

        if (dbOk) {
          for (const table of ["factory_projects", "tasks", "memories", "capture_state"]) {
            try {
              const present = await deps.db.tableExists(table);
              const memoryTable = table === "memories" || table === "capture_state";
              add(
                `tabla:${table}`,
                present ? "ok" : memoryTable ? "warn" : "error",
                present
                  ? "existe"
                  : memoryTable
                    ? "falta; instala opencode-memory para poder cerrar tareas"
                    : "falta; aplica la migración pendiente",
              );
            } catch (error) {
              add(`tabla:${table}`, "error", error instanceof Error ? error.message : String(error));
            }
          }
          for (const table of [
            "gate_runs",
            "review_runs",
            "factory_meta",
            "plans",
            "plan_tasks",
            "plan_reviews",
            "plan_validations",
            "subtask_runs",
            "phase_closures",
            "factory_models",
            "factory_agent_catalog",
            "factory_execution_profiles",
            "factory_profile_assignments",
            "factory_audit_events",
            "factory_execution_log",
            "factory_budgets",
            "factory_budget_reservations",
            "factory_model_prices",
          ]) {
            try {
              const present = await deps.db.tableExists(table);
              add(`tabla:${table}`, present ? "ok" : "error", present ? "existe" : "falta; aplica la migración pendiente");
            } catch (error) {
              add(`tabla:${table}`, "error", error instanceof Error ? error.message : String(error));
            }
          }
          try {
            const version = await deps.db.getMeta("schema_version");
            const numeric = Number(version);
            add("migración:schema_version", numeric === 8 ? "ok" : "error", `schema_version=${String(version ?? "desconocida")}; esperado 8`);
          } catch (error) {
            add("migración:schema_version", "error", error instanceof Error ? error.message : String(error));
          }
          for (const [table, column] of [
            ["factory_projects", "commands"],
            ["factory_projects", "quality"],
            ["factory_projects", "baseline"],
            ["factory_projects", "baseline_at"],
            ["factory_projects", "autonomy"],
            ["factory_projects", "max_concurrency"],
            ["tasks", "acceptance_criteria"],
            ["tasks", "closure_report"],
            ["tasks", "closed_at"],
            ["tasks", "author_model"],
            ["plans", "review_round"],
            ["plans", "review_exhausted"],
            ["plans", "residual_findings"],
            ["plans", "approval_waiver"],
            ["plans", "validation"],
            ["plan_tasks", "status"],
            ["plan_tasks", "worktree"],
            ["plan_reviews", "blocking_count"],
            ["plan_reviews", "advisory_count"],
            ["plan_reviews", "new_findings"],
            ["plan_reviews", "resolved_findings"],
            ["review_runs", "session_id"],
            ["review_runs", "tokens_input"],
            ["review_runs", "tokens_output"],
            ["review_runs", "tokens_reasoning"],
            ["review_runs", "tokens_cache_read"],
            ["review_runs", "tokens_cache_write"],
            ["review_runs", "cost_usd"],
            ["review_runs", "cost_source"],
            ["factory_models", "authorized"],
            ["factory_models", "prohibited"],
            ["factory_models", "capabilities"],
            ["factory_models", "cost_input"],
            ["factory_execution_profiles", "is_default"],
            ["factory_profile_assignments", "locked"],
            ["factory_profile_assignments", "token_budget"],
            ["factory_execution_log", "cost_usd"],
            ["factory_execution_log", "project_id"],
            ["factory_execution_log", "parent_execution_id"],
            ["factory_execution_log", "selection_reason"],
            ["factory_execution_log", "price_version"],
            ["factory_execution_log", "weighted_tokens"],
            ["factory_execution_log", "budget_unit"],
            ["factory_execution_log", "overrun_ratio"],
            ["factory_budgets", "token_budget"],
            ["factory_budgets", "reserved_weighted_tokens"],
            ["factory_budget_reservations", "status"],
            ["factory_budget_reservations", "reserved_weighted_tokens"],
            ["factory_model_prices", "version"],
          ] as const) {
            try {
              const present = await deps.db.columnExists(table, column);
              add(`columna:${table}.${column}`, present ? "ok" : "error", present ? "existe" : "falta; aplica la migración pendiente");
            } catch (error) {
              add(`columna:${table}.${column}`, "error", error instanceof Error ? error.message : String(error));
            }
          }
        }

        if (deps.planStore) {
          try {
            const worktrees = await runCommand("git worktree list --porcelain", project.directory, 15_000);
            const known = new Set(
              worktrees.exitCode === 0
                ? worktrees.stdout.split(/\r?\n/)
                    .filter((line) => line.startsWith("worktree "))
                    .map((line) => line.slice("worktree ".length).trim())
                : [],
            );
            const registered = await deps.planStore.listPlanTasksByWorktree(project.projectId);
            const registeredPaths = new Set(registered.map((task) => task.worktree).filter((path): path is string => Boolean(path)));
            const localRoot = worktreeRoot(project.name);
            const localDirs = existsSync(localRoot)
              ? readdirSync(localRoot, { withFileTypes: true })
                  .filter((entry) => entry.isDirectory())
                  .map((entry) => join(localRoot, entry.name))
              : [];
            const orphan = [...new Set([
              ...[...known].filter((path) => path !== project.directory && !registeredPaths.has(path)),
              ...localDirs.filter((path) => !known.has(path) && !registeredPaths.has(path)),
            ])];
            const missing = registered.filter((task) => task.worktree && !existsSync(task.worktree));
            const broken: typeof registered = [];
            for (const task of registered) {
              if (!task.worktree || !existsSync(task.worktree)) continue;
              const valid = await runCommand(
                `git -C ${shellQuote(task.worktree)} rev-parse --is-inside-work-tree`,
                project.directory,
                10_000,
              );
              if (valid.exitCode !== 0 || valid.stdout.trim() !== "true") broken.push(task);
            }
            add(
              "worktrees:huérfanos",
              orphan.length > 0 ? "warn" : "ok",
              orphan.length > 0 ? `${orphan.length} worktree(s) fuera del plan: ${orphan.join(", ")}` : "sin worktrees huérfanos",
            );
            add(
              "worktrees:registrados",
              missing.length > 0 ? "warn" : "ok",
              missing.length > 0 ? `${missing.length} worktree(s) del plan no existen: ${missing.map((task) => task.worktree).join(", ")}` : "todos los worktrees del plan existen",
            );
            add(
              "worktrees:rotos",
              broken.length > 0 ? "warn" : "ok",
              broken.length > 0 ? `${broken.length} worktree(s) con .git roto: ${broken.map((task) => task.worktree).join(", ")}` : "sin worktrees con .git roto",
            );
            add("worktrees:raíz", "ok", localRoot);
            const stale = await deps.planStore.listStalePlanTasks(project.projectId, 90);
            add(
              "plan:tareas_colgadas",
              stale.length > 0 ? "warn" : "ok",
              stale.length > 0 ? `${stale.length} tarea(s) running/review sin actualizar > 90 min` : "sin tareas colgadas",
            );
          } catch (error) {
            add("orquestación:worktrees", "warn", error instanceof Error ? error.message : String(error));
          }
        }

        if (deps.mam) {
          try {
            const staleExecutions = await deps.mam.store.staleExecutions(90);
            add(
              "execution:abiertas",
              staleExecutions.length > 0 ? "warn" : "ok",
              staleExecutions.length > 0
                ? `${staleExecutions.length} ejecución(es) running > 90 min; usa plan_resume o revisa el execution log`
                : "sin ejecuciones abiertas",
            );
            const staleReservations = await deps.mam.store.staleReservations(90);
            add(
              "budget:reservas_abiertas",
              staleReservations.length > 0 ? "warn" : "ok",
              staleReservations.length > 0
                ? `${staleReservations.length} reserva(s) sin liquidar > 90 min; revisa presupuestos`
                : "sin reservas abiertas",
            );
            const overruns = await deps.mam.store.overrunRoles();
            add(
              "budget:sobreconsumo",
              overruns.length > 0 ? "warn" : "ok",
              overruns.length > 0
                ? overruns
                    .map(
                      (item) =>
                        `${item.role}: ${item.overruns}/${item.runs} ejecuciones > 1,5x la reserva`,
                    )
                    .join(" · ")
                : "sin sobreconsumo repetido",
            );
          } catch (error) {
            add("execution:diagnóstico", "warn", error instanceof Error ? error.message : String(error));
          }
        }

        const packsDirectory = join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "plugins",
          "factory",
          "rules",
          "packs",
        );
        try {
          const packs = readdirSync(packsDirectory).filter((file) => file.endsWith(".yml"));
          if (packs.length === 0) throw new Error("sin packs");
          const maxAgeDays = Math.max(
            ...packs.map((file) => (Date.now() - statSync(join(packsDirectory, file)).mtimeMs) / 86_400_000),
          );
          add(
            "semgrep:packs",
            maxAgeDays <= 60 ? "ok" : "warn",
            `${packs.length} packs vendorizados; el más antiguo tiene ${maxAgeDays.toFixed(0)} días${maxAgeDays > 60 ? "; refresca con el comando del README" : ""}`,
          );
        } catch {
          add("semgrep:packs", "warn", "no se encontraron packs vendorizados");
        }

        for (const scanner of EXPECTED_SCANNERS) {
          const executable = findExecutable(scanner);
          if (!executable) {
            add(`scanner:${scanner}`, "warn", "no está en PATH");
            continue;
          }
          const result = await runCommand(`${scanner} --version`, project.directory, 5_000);
          add(
            `scanner:${scanner}`,
            result.exitCode === 0 ? "ok" : "warn",
            result.exitCode === 0 ? firstLine(result.stdout || result.stderr) : `presente en ${executable}, pero --version falló`,
          );
        }

        let agents: Record<string, unknown>[] = [];
        let models: Record<string, unknown>[] = [];
        try {
          agents = asData(await deps.diagnostics.listAgents());
          add("agentes", agents.length > 0 ? "ok" : "error", `${agents.length} agentes visibles`);
        } catch (error) {
          add("agentes", "error", error instanceof Error ? error.message : String(error));
        }
        try {
          models = asData(await deps.diagnostics.listModels());
          add("modelos", models.length > 0 ? "ok" : "error", `${models.length} modelos visibles`);
        } catch (error) {
          add("modelos", "error", error instanceof Error ? error.message : String(error));
        }

        for (const [agentId, expected] of Object.entries(EXPECTED_AGENTS)) {
          const agent = agents.find((item) => item.id === agentId);
          if (!agent) {
            add(`agente:${agentId}`, "error", "no existe el agente");
            continue;
          }
          const model = agent.model && typeof agent.model === "object" ? (agent.model as Record<string, unknown>) : {};
          const actual = `${String(model.providerID ?? "")}/${String(model.id ?? "")}`;
          const [providerID, modelID] = expected.split("/");
          const available = models.find(
            (item) => item.providerID === providerID && (item.modelID === modelID || item.id === modelID),
          );
          if (actual !== expected) {
            add(`agente:${agentId}`, "warn", `modelo configurado ${actual || "desconocido"}; esperado ${expected}`);
          } else if (!available) {
            add(`agente:${agentId}`, "error", `modelo ${expected} no está disponible en el catálogo`);
          } else if (available.enabled === false || available.status === "deprecated") {
            add(`agente:${agentId}`, "warn", `modelo ${expected} está deshabilitado o deprecado`);
          } else {
            add(`agente:${agentId}`, "ok", `modelo ${expected} disponible`);
          }
        }

        try {
          const plugins = asData(await deps.diagnostics.listPlugins());
          const text = JSON.stringify(plugins);
          add(
            "plugin:memoria",
            /opencode[.-]memory|opencode-memory/i.test(text) ? "ok" : "warn",
            /opencode[.-]memory|opencode-memory/i.test(text) ? "plugin de memoria presente" : "plugin de memoria no detectado",
          );
          add(
            "plugin:factory",
            /opencode[.-]factory|opencode-factory/i.test(text) ? "ok" : "warn",
            /opencode[.-]factory|opencode-factory/i.test(text) ? "plugin de la fábrica presente" : "plugin de la fábrica no detectado",
          );
        } catch (error) {
          add("plugins", "warn", error instanceof Error ? error.message : String(error));
        }

        try {
          const tools = asData(await deps.diagnostics.listTools());
          const ids = tools.map((tool) => String(tool.id ?? ""));
          const missing = EXPECTED_TOOLS.filter((name) => !ids.some((id) => id === name || id.endsWith(`.${name}`) || id.endsWith(`_${name}`)));
          add("tools", missing.length === 0 ? "ok" : "error", missing.length === 0 ? "todas las tools esperadas registradas" : `faltan: ${missing.join(", ")}`);
        } catch (error) {
          add("tools", "error", error instanceof Error ? error.message : String(error));
        }

        const errors = checks.filter((check) => check.status === "error");
        const warnings = checks.filter((check) => check.status === "warn");
        return ok({
          ok: errors.length === 0,
          checked_at: new Date().toISOString(),
          project: { id: project.projectId, path: project.directory },
          summary: `${checks.length - errors.length - warnings.length} ok, ${warnings.length} warn, ${errors.length} error`,
          checks,
          errors: errors.map((check) => `${check.name}: ${check.detail}`),
          warnings: warnings.map((check) => `${check.name}: ${check.detail}`),
        });
      },
    },
  ];
}
