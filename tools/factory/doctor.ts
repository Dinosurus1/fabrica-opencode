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

import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryDb, ProjectRef } from "./db.js";
import { redact, runCommand, tail } from "./exec.js";
import { ok, type ToolDef } from "./types.js";

export interface DoctorDeps {
  db: FactoryDb;
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
  "security-reviewer": "opencode-go/glm-5.3-flash",
  "code-reviewer": "opencode-go/claude-haiku-5-5",
  "qa-engineer": "opencode-go/minimax-m3",
  helper: "opencode-go/glm-5.3-flash",
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
          for (const table of ["gate_runs", "review_runs", "factory_meta"]) {
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
            add("migración:schema_version", numeric === 3 ? "ok" : "error", `schema_version=${String(version ?? "desconocida")}; esperado 3`);
          } catch (error) {
            add("migración:schema_version", "error", error instanceof Error ? error.message : String(error));
          }
          for (const [table, column] of [
            ["factory_projects", "commands"],
            ["factory_projects", "quality"],
            ["factory_projects", "baseline"],
            ["factory_projects", "baseline_at"],
            ["tasks", "acceptance_criteria"],
            ["tasks", "closure_report"],
            ["tasks", "closed_at"],
            ["review_runs", "session_id"],
            ["review_runs", "tokens_input"],
            ["review_runs", "tokens_output"],
            ["review_runs", "tokens_reasoning"],
            ["review_runs", "tokens_cache_read"],
            ["review_runs", "tokens_cache_write"],
            ["review_runs", "cost_usd"],
            ["review_runs", "cost_source"],
          ] as const) {
            try {
              const present = await deps.db.columnExists(table, column);
              add(`columna:${table}.${column}`, present ? "ok" : "error", present ? "existe" : "falta; aplica la migración pendiente");
            } catch (error) {
              add(`columna:${table}.${column}`, "error", error instanceof Error ? error.message : String(error));
            }
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
