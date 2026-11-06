/**
 * Plugin `opencode.factory`.
 *
 * Qué hace: registra las tools de la fábrica (project_detect, project_profile_get,
 * project_profile_set, task_create, task_update, task_list, run_checks,
 * security_scan) en OpenCode V2. Reutiliza la misma base PostgreSQL/pgvector de
 * opencode-memory, pero solo crea sus propias tablas `factory_projects` y `tasks`.
 *
 * Qué accede: PostgreSQL local, el archivo de migración y, a través de las tools,
 * archivos del proyecto y procesos hijos. Las tools que ejecutan shell piden
 * permiso con `ctx.permission.assert` antes de lanzar nada.
 *
 * Configuración: `FACTORY_DATABASE_URL` o `OPENCODE_MEMORY_DATABASE_URL`; si no
 * existen, usa la base local de opencode-memory. Nunca registra la URL completa.
 */

import { Plugin } from "@opencode/plugin";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFactoryDb, type QueryFn } from "../../tools/factory/db.js";
import { createFactoryTools } from "../../tools/factory/index.js";
import { redact } from "../../tools/factory/exec.js";
import type { ModelPrice, SessionUsageSnapshot } from "../../tools/factory/usage.js";

const DEFAULT_DATABASE_URL = "postgres://opencode@127.0.0.1:5433/opencode_memory";

export default Plugin.define({
  id: "opencode.factory",
  async setup(ctx) {
    const pluginDirectory = dirname(fileURLToPath(import.meta.url));
    // `createRequire` resuelve `pg` en runtime. Primero intenta reutilizar el
    // `pg` que opencode-memory ya cargó (evita una segunda copia y funciona en
    // servicios que ya estaban arrancados); si no, usa el node_modules propio.
    const requireFromPlugin = createRequire(import.meta.url);
    const memoryEntry = join(pluginDirectory, "..", "opencode-memory", "memory.ts");
    let pg: typeof import("pg");
    try {
      pg = createRequire(pathToFileURL(memoryEntry).href)("pg") as typeof import("pg");
    } catch {
      pg = requireFromPlugin("pg") as typeof import("pg");
    }
    const databaseUrl =
      process.env.FACTORY_DATABASE_URL ??
      process.env.OPENCODE_MEMORY_DATABASE_URL ??
      DEFAULT_DATABASE_URL;

    const migrationDirectory = join(pluginDirectory, "migrations");
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const migrations = await Promise.all(
      migrationFiles.map((file) => readFile(join(migrationDirectory, file), "utf8")),
    );

    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 3,
      connectionTimeoutMillis: 4_000,
      idleTimeoutMillis: 30_000,
      application_name: "opencode-factory",
    });
    pool.on("error", (error) => {
      // Solo el mensaje redactado: nunca la cadena de conexión.
      console.error("[opencode-factory] PostgreSQL pool error:", redact(error.message));
    });

    const query = ((sql: string, params?: readonly unknown[]) =>
      pool.query(sql, params as unknown[] | undefined)) as unknown as QueryFn;
    const db = createFactoryDb(query, migrations);

    const log = (...args: unknown[]) => console.log("[opencode-factory]", ...args);
    void db
      .init()
      .then(() => log("tools registradas · tablas factory_projects/tasks disponibles"))
      .catch((error) => {
        log(
          "base de datos no disponible; las tools fallarán hasta que arranque:",
          redact(error instanceof Error ? error.message : String(error)),
        );
      });

    const fallbackProject = {
      projectId: String(ctx.location.project.id ?? "unknown"),
      directory: ctx.location.project.canonical ?? ctx.location.directory,
      name: basename(ctx.location.project.canonical ?? ctx.location.directory),
    };

    async function resolveProject(sessionID: string) {
      try {
        const session = await ctx.session.get({ sessionID });
        const directory = session.location?.directory ?? fallbackProject.directory;
        return {
          projectId: String(session.projectID ?? fallbackProject.projectId),
          directory,
          name: basename(directory),
        };
      } catch {
        return fallbackProject;
      }
    }

    /**
     * Uso acumulado de una sesión. `cost` solo es > 0 cuando el proveedor lo
     * reporta; para el resto se estima con el catálogo en `resolveModelPrice`.
     */
    async function getSessionUsage(sessionID: string): Promise<SessionUsageSnapshot | null> {
      try {
        const session = (await ctx.session.get({ sessionID })) as unknown as Record<string, unknown>;
        const rawTokens = (session.tokens ?? {}) as Record<string, unknown>;
        const rawCache = (rawTokens.cache ?? {}) as Record<string, unknown>;
        const rawModel = (session.model ?? null) as Record<string, unknown> | null;
        let model = rawModel ? `${String(rawModel.providerID ?? "")}/${String(rawModel.id ?? "")}`.replace(/^\/|\/$/g, "") : "";

        // Algunas sesiones del orquestador no tienen `model` persistido; el
        // último mensaje del asistente sí lo lleva. Solo se consulta si falta.
        if (!model) {
          try {
            const messages = (await ctx.session.context({ sessionID })) as unknown as Array<Record<string, unknown>>;
            for (let index = messages.length - 1; index >= 0; index -= 1) {
              const message = messages[index]!;
              if (message.type !== "assistant") continue;
              const messageModel = message.model as Record<string, unknown> | undefined;
              if (messageModel?.providerID && messageModel?.id) {
                model = `${String(messageModel.providerID)}/${String(messageModel.id)}`;
                break;
              }
            }
          } catch {
            // El uso sigue siendo válido aunque no se pueda inferir el modelo.
          }
        }

        return {
          sessionId: sessionID,
          model,
          tokens: {
            input: Number(rawTokens.input ?? 0),
            output: Number(rawTokens.output ?? 0),
            reasoning: Number(rawTokens.reasoning ?? 0),
            cacheRead: Number(rawCache.read ?? 0),
            cacheWrite: Number(rawCache.write ?? 0),
          },
          costUsd: Number(session.cost ?? 0),
        };
      } catch {
        return null;
      }
    }

    /**
     * Precio por millón de tokens del catálogo de modelos. Elige el tramo de
     * contexto que corresponde a los tokens observados; si no hay tramos,
     * usa el precio base.
     */
    async function resolveModelPrice(modelRef: string, contextTokens: number): Promise<ModelPrice | null> {
      const ref = modelRef.trim();
      if (!ref) return null;
      try {
        const listed = (await ctx.model.list()) as unknown;
        const models = (Array.isArray(listed)
          ? listed
          : (listed as { data?: unknown })?.data) as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(models)) return null;
        const slash = ref.indexOf("/");
        const providerID = slash >= 0 ? ref.slice(0, slash) : "";
        const modelID = slash >= 0 ? ref.slice(slash + 1) : ref;
        const found = models.find((item) => {
          const sameProvider = providerID === "" || String(item.providerID ?? "") === providerID;
          return sameProvider && (String(item.modelID ?? "") === modelID || String(item.id ?? "") === modelID);
        });
        if (!found) return null;
        const costs = Array.isArray(found.cost) ? (found.cost as Array<Record<string, unknown>>) : [];
        if (costs.length === 0) return null;

        const readEntry = (entry: Record<string, unknown>) => {
          const cache = (entry.cache ?? {}) as Record<string, unknown>;
          return {
            input: Number(entry.input ?? 0),
            output: Number(entry.output ?? 0),
            cacheRead: Number(cache.read ?? 0),
            cacheWrite: Number(cache.write ?? 0),
          };
        };

        let chosen = costs.find((entry) => !entry.tier) ?? costs[0]!;
        let basis = "catálogo, precio base";
        for (const entry of costs) {
          const tier = entry.tier as Record<string, unknown> | undefined;
          if (tier?.type === "context" && Number(tier.size ?? 0) > 0 && contextTokens > Number(tier.size)) {
            chosen = entry;
            basis = `catálogo, tramo contexto > ${Number(tier.size)} tokens`;
          }
        }
        return { ...readEntry(chosen), basis };
      } catch {
        return null;
      }
    }

    await ctx.tool.transform((editor) => {
      for (const tool of createFactoryTools({
        db,
        resolveProject,
        permission: {
          assert: (input) => ctx.permission.assert(input as never),
        },
        diagnostics: {
          listAgents: () => ctx.agent.list(),
          listModels: () => ctx.model.list(),
          listPlugins: () => ctx.plugin.list(),
          listTools: () => ctx.tool.list(),
        },
        usage: {
          getSessionUsage,
          getModelPrice: resolveModelPrice,
        },
      })) {
        editor.add(tool as never);
      }
    });

    return async () => {
      await pool.end().catch(() => {});
    };
  },
});
