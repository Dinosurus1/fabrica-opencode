/**
 * Puente opcional con el plugin de memoria.
 *
 * Qué hace: reutiliza `MemoryStore` de `plugins/opencode-memory` para generar
 * embeddings y garantizar el esquema de memoria viva (entity_key, doc,
 * historial, soft delete). Si el plugin no está instalado, las tools de memoria
 * fallan con un mensaje claro; no simulan resultados.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { QueryFn } from "../../tools/factory/db.js";

export interface MemoryBridge {
  prepare(): Promise<void>;
  embed(text: string): Promise<number[]>;
  close(): Promise<void>;
}

export function createMemoryBridge(pluginDirectory: string, query: QueryFn): MemoryBridge {
  let storePromise: Promise<any> | null = null;
  let schemaReady: Promise<void> | null = null;

  async function loadStore() {
    if (!storePromise) {
      storePromise = (async () => {
        const modulePath = join(pluginDirectory, "..", "opencode-memory", "memory.ts");
        const module = await import(pathToFileURL(modulePath).href);
        let fileOptions: Record<string, unknown> = {};
        try {
          fileOptions = JSON.parse(
            readFileSync(join(pluginDirectory, "..", "opencode-memory", "config.json"), "utf8"),
          ) as Record<string, unknown>;
        } catch {
          // config.json es opcional; se usan los valores por defecto.
        }
        const config = module.readConfig(fileOptions);
        const store = new module.MemoryStore(config);
        await store.init();
        return store;
      })();
    }
    return storePromise;
  }

  async function prepareSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        await loadStore();
        await query(`
          ALTER TABLE memories ADD COLUMN IF NOT EXISTS entity_key text;
          ALTER TABLE memories ADD COLUMN IF NOT EXISTS doc jsonb NOT NULL DEFAULT '{}'::jsonb;
          ALTER TABLE memories ADD COLUMN IF NOT EXISTS related text[] NOT NULL DEFAULT '{}'::text[];
          ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;
          ALTER TABLE memories ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
          ALTER TABLE memories ADD COLUMN IF NOT EXISTS merged_into uuid;
          CREATE UNIQUE INDEX IF NOT EXISTS memories_entity_key_idx
            ON memories (scope, project_id, entity_key)
            WHERE entity_key IS NOT NULL AND deleted_at IS NULL;
          CREATE INDEX IF NOT EXISTS memories_deleted_idx
            ON memories (deleted_at)
            WHERE deleted_at IS NOT NULL;
          CREATE TABLE IF NOT EXISTS memory_backups (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            label text,
            created_at timestamptz NOT NULL DEFAULT now(),
            payload jsonb NOT NULL
          );
        `);
      })();
    }
    return schemaReady;
  }

  return {
    async prepare() {
      await prepareSchema();
    },
    async embed(text: string) {
      const store = await loadStore();
      return store.embed(text);
    },
    async close() {
      if (storePromise) {
        const store = await storePromise;
        await store.close?.();
        storePromise = null;
        schemaReady = null;
      }
    },
  };
}
