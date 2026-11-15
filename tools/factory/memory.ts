/**
 * Memoria viva: upsert por entidad, backup, consolidación dry-run y
 * verificación. No borra memorias: usa soft delete y enlaza al documento
 * consolidado. La propuesta de consolidación no se aplica sin confirmación.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { QueryFn } from "./db.js";
import type { MamRuntime } from "./mam.js";
import { slugify } from "./paths.js";
import { fail, looksLikeSecret, ok, type ToolDef } from "./types.js";

export interface MemoryBridgeLike {
  prepare(): Promise<void>;
  embed(text: string): Promise<number[]>;
}

export interface MemoryToolsDeps {
  query: QueryFn;
  mam: MamRuntime;
  memory: MemoryBridgeLike;
  resolveProject: (sessionID: string) => Promise<{ projectId: string; directory: string; name: string }>;
}

interface MemoryRow {
  id: string;
  scope: "global" | "project";
  project_id: string;
  project_path: string | null;
  kind: string;
  title: string | null;
  content: string;
  tags: string[];
  importance: number;
  pinned: boolean;
  entity_key: string | null;
  doc: unknown;
  related: string[];
  updated_at: Date | string;
}

type SectionMap = Record<string, string>;

interface HistoryEntry {
  date: string;
  section: string;
  old: string;
  new: string;
  reason: string;
}

const ENTITY_RE = /^(project|preference|decision|lesson):[a-z0-9][a-z0-9-]*$/;
const PROJECT_SECTIONS = [
  "Resumen",
  "Stack",
  "Estado actual",
  "Decisiones",
  "Pendientes",
  "Historial de cambios",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function contentHash(content: string): string {
  return createHash("sha256").update(normalizeText(content)).digest("hex");
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asSections(value: unknown): SectionMap {
  const raw = asObject(value);
  const sections: SectionMap = {};
  for (const [key, content] of Object.entries(raw)) {
    if (typeof content === "string" && content.trim()) {
      sections[key] = content.trim();
    }
  }
  return sections;
}

function asHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      date: String(entry.date ?? ""),
      section: String(entry.section ?? ""),
      old: String(entry.old ?? ""),
      new: String(entry.new ?? ""),
      reason: String(entry.reason ?? ""),
    }))
    .filter((entry) => entry.section);
}

function renderSections(sections: SectionMap, history: HistoryEntry[]): string {
  const keys = [
    ...PROJECT_SECTIONS.filter((key) => key !== "Historial de cambios"),
    ...Object.keys(sections).filter((key) => !PROJECT_SECTIONS.includes(key)),
  ];
  const parts: string[] = [];
  for (const key of keys) {
    const value = sections[key];
    if (value && value.trim()) parts.push(`## ${key}\n${value.trim()}`);
  }
  const historySection = (sections["Historial de cambios"] ?? "").trim();
  if (historySection || history.length > 0) {
    const lines: string[] = [];
    if (historySection) lines.push(historySection);
    if (history.length > 0) {
      lines.push(
        history
          .slice(-30)
          .map((entry) => `- ${entry.date.slice(0, 10)} · ${entry.section}: ${entry.reason || "cambio"}`)
          .join("\n"),
      );
    }
    parts.push(`## Historial de cambios\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

function defaultScope(entityKey: string): "global" | "project" {
  if (entityKey.startsWith("preference:") || entityKey.startsWith("lesson:")) return "global";
  return "project";
}

function defaultKind(entityKey: string): string {
  if (entityKey.startsWith("preference:")) return "preference";
  if (entityKey.startsWith("decision:")) return "decision";
  if (entityKey.startsWith("project:")) return "convention";
  return "fact";
}

function scopeProject(
  entityKey: string,
  requested: unknown,
  project: { projectId: string; directory: string; name: string },
): { scope: "global" | "project"; projectId: string; projectPath: string | null } {
  const scope = requested === "global" || requested === "project" ? requested : defaultScope(entityKey);
  return scope === "project"
    ? { scope, projectId: project.projectId, projectPath: project.directory }
    : { scope, projectId: "", projectPath: null };
}

async function loadMemory(query: QueryFn, id: string): Promise<MemoryRow | null> {
  const result = await query<MemoryRow>(
    `SELECT id, scope, project_id, project_path, kind, title, content, tags,
            importance, pinned, entity_key, doc, related, updated_at
     FROM memories WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findEntity(
  query: QueryFn,
  scope: string,
  projectId: string,
  entityKey: string,
): Promise<MemoryRow | null> {
  const result = await query<MemoryRow>(
    `SELECT id, scope, project_id, project_path, kind, title, content, tags,
            importance, pinned, entity_key, doc, related, updated_at
     FROM memories
     WHERE scope = $1 AND project_id = $2 AND entity_key = $3 AND deleted_at IS NULL
     LIMIT 1`,
    [scope, projectId, entityKey],
  );
  return result.rows[0] ?? null;
}

async function similarCandidates(
  query: QueryFn,
  search: string,
  excludeId: string | null,
): Promise<Array<{ id: string; entity_key: string | null; title: string | null; updated_at: string }>> {
  if (!search.trim()) return [];
  const result = await query<{
    id: string;
    entity_key: string | null;
    title: string | null;
    updated_at: Date | string;
  }>(
    `SELECT id, entity_key, title, updated_at FROM memories
     WHERE deleted_at IS NULL
       AND (title ILIKE $1 OR content ILIKE $1)
       AND ($2::uuid IS NULL OR id <> $2::uuid)
     ORDER BY updated_at DESC LIMIT 5`,
    [`%${search.slice(0, 120)}%`, excludeId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    entity_key: row.entity_key,
    title: row.title,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }));
}

interface UpsertInput {
  entityKey: string;
  scope: "global" | "project";
  projectId: string;
  projectPath: string | null;
  kind: string;
  title: string | null;
  sections: SectionMap;
  tags: string[];
  importance: number;
  pinned: boolean;
  related: string[];
  reason: string;
  lastVerifiedAt: string;
  sourceSession: string | null;
  replaceSections?: boolean;
}

async function upsertMemory(
  deps: MemoryToolsDeps,
  input: UpsertInput,
): Promise<{ action: "noop" | "created" | "updated" | "conflict"; id?: string; historyAppended: number; existingId?: string }> {
  const existing = await findEntity(deps.query, input.scope, input.projectId, input.entityKey);
  if (!existing) {
    const content = renderSections(input.sections, []);
    if (!content.trim()) throw new Error("La memoria no tiene contenido en sus secciones.");
    const embedding = await deps.memory.embed(`${input.title ? `${input.title}. ` : ""}${content}`);
    try {
      const result = await deps.query<{ id: string }>(
        `INSERT INTO memories (
           scope, project_id, project_path, kind, title, content, tags, importance,
           pinned, content_hash, embedding, source_session, entity_key, doc,
           related, last_verified_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12,$13,$14::jsonb,$15,$16)
         RETURNING id`,
        [
          input.scope,
          input.projectId,
          input.projectPath,
          input.kind,
          input.title,
          content,
          input.tags,
          input.importance,
          input.pinned,
          contentHash(content),
          vectorLiteral(embedding),
          input.sourceSession,
          input.entityKey,
          JSON.stringify({ sections: input.sections, history: [] }),
          input.related,
          input.lastVerifiedAt,
        ],
      );
      return { action: "created", id: result.rows[0]!.id, historyAppended: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate key")) throw error;
      const duplicate = await deps.query<{ id: string }>(
        `SELECT id FROM memories WHERE scope = $1 AND project_id = $2 AND content_hash = $3 AND deleted_at IS NULL LIMIT 1`,
        [input.scope, input.projectId, contentHash(content)],
      );
      return { action: "conflict", existingId: duplicate.rows[0]?.id, historyAppended: 0 };
    }
  }

  const doc = asObject(existing.doc);
  const oldSections = asSections(doc.sections);
  const history = asHistory(doc.history);
  const mergedSections: SectionMap = input.replaceSections ? {} : { ...oldSections };
  const additions: HistoryEntry[] = [];
  const now = new Date().toISOString();
  for (const [section, value] of Object.entries(input.sections)) {
    const old = mergedSections[section] ?? "";
    if (value.trim() === old.trim()) continue;
    mergedSections[section] = value.trim();
    additions.push({
      date: now,
      section,
      old,
      new: value.trim(),
      reason: input.reason || "actualización",
    });
  }
  const mergedHistory = [...history, ...additions];
  const content = renderSections(mergedSections, mergedHistory);
  const tags = [...new Set([...(existing.tags ?? []), ...input.tags])];
  const related = [...new Set([...(existing.related ?? []), ...input.related])].filter(
    (item) => item !== input.entityKey,
  );
  const unchanged =
    content === existing.content &&
    JSON.stringify(mergedSections) === JSON.stringify(oldSections) &&
    JSON.stringify(tags) === JSON.stringify(existing.tags ?? []) &&
    JSON.stringify(related) === JSON.stringify(existing.related ?? []) &&
    existing.title === input.title &&
    existing.importance === input.importance &&
    existing.pinned === input.pinned;
  if (unchanged) return { action: "noop", id: existing.id, historyAppended: 0 };

  const embedding = await deps.memory.embed(`${input.title ? `${input.title}. ` : ""}${content}`);
  await deps.query(
    `UPDATE memories SET
       title = $2, content = $3, tags = $4, importance = $5, pinned = $6,
       content_hash = $7, embedding = $8::vector, entity_key = $9,
       doc = $10::jsonb, related = $11, last_verified_at = $12, updated_at = now()
     WHERE id = $1`,
    [
      existing.id,
      input.title,
      content,
      tags,
      input.importance,
      input.pinned,
      contentHash(content),
      vectorLiteral(embedding),
      input.entityKey,
      JSON.stringify({ sections: mergedSections, history: mergedHistory }),
      related,
      input.lastVerifiedAt,
    ],
  );
  return { action: "updated", id: existing.id, historyAppended: additions.length };
}

async function createBackup(
  deps: MemoryToolsDeps,
  label: string | null,
  ids?: string[],
): Promise<{ id: string; path: string; count: number; created_at: string }> {
  const rows = await deps.query<Record<string, unknown>>(
    `SELECT id, scope, project_id, project_path, kind, title, content, tags,
            importance, pinned, content_hash, source_session, source_message,
            created_at, updated_at, last_used_at, use_count, entity_key, doc,
            related, last_verified_at, deleted_at, merged_into
     FROM memories
     WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
     ORDER BY updated_at DESC`,
    [ids && ids.length > 0 ? ids : null],
  );
  const createdAt = new Date().toISOString();
  const payload = { label, created_at: createdAt, count: rows.rows.length, memories: rows.rows };
  const inserted = await deps.query<{ id: string }>(
    `INSERT INTO memory_backups (label, payload) VALUES ($1, $2::jsonb) RETURNING id`,
    [label, JSON.stringify(payload)],
  );
  const id = inserted.rows[0]!.id;
  const directory = join(homedir(), ".config", "opencode", "backups");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `memory-${id}.json`);
  await writeFile(path, JSON.stringify({ ...payload, backup_id: id }, null, 2), { mode: 0o600 });
  return { id, path, count: rows.rows.length, created_at: createdAt };
}

function tokensOf(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .toLowerCase()
      .split(/[^a-z0-9áéíóúüñ]+/i)
      .filter((word) => word.length >= 4),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function parseSectionsFromContent(content: string): SectionMap {
  const sections: SectionMap = {};
  const matches = [...content.matchAll(/^##\s+(.+)$/gm)];
  if (matches.length === 0) return { Resumen: content.trim() };
  for (let index = 0; index < matches.length; index += 1) {
    const title = matches[index]![1]!.trim();
    const start = matches[index]!.index! + matches[index]![0].length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : content.length;
    const value = content.slice(start, end).trim();
    if (value) sections[title] = value;
  }
  return sections;
}

export function createMemoryTools(deps: MemoryToolsDeps): ToolDef[] {
  return [
    {
      name: "memory_upsert",
      description:
        "Crea o actualiza una memoria viva por entity_key (project:, preference:, decision:, lesson:). Busca antes, decide NOOP/UPDATE/CREATE, conserva historial y marca la última verificación. No guarda secretos ni datos efímeros.",
      input: {
        type: "object",
        properties: {
          entity_key: {
            type: "string",
            pattern: "^(project|preference|decision|lesson):[a-z0-9][a-z0-9-]*$",
          },
          scope: { type: "string", enum: ["global", "project"] },
          project_id: { type: "string", maxLength: 120 },
          project_path: { type: "string", maxLength: 1024 },
          kind: {
            type: "string",
            enum: ["preference", "fact", "decision", "convention", "snippet"],
          },
          title: { type: "string", maxLength: 120 },
          sections: { type: "object", additionalProperties: { type: "string" } },
          content: { type: "string", maxLength: 6000 },
          tags: { type: "array", items: { type: "string" } },
          importance: { type: "integer", minimum: 1, maximum: 5, default: 3 },
          pinned: { type: "boolean", default: false },
          related: { type: "array", items: { type: "string" } },
          reason: { type: "string", maxLength: 500 },
          last_verified_at: { type: "string" },
        },
        required: ["entity_key"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          await deps.memory.prepare();
          const entityKey = String(input.entity_key ?? "").trim();
          if (!ENTITY_RE.test(entityKey)) {
            return fail("entity_key inválido. Usa project:<slug>, preference:<tema>, decision:<slug> o lesson:<slug>.");
          }
          const project = await deps.resolveProject(String(context.sessionID));
          const target = scopeProject(entityKey, input.scope, {
            projectId:
              typeof input.project_id === "string" && input.project_id.trim()
                ? input.project_id.trim()
                : project.projectId,
            directory:
              typeof input.project_path === "string" && input.project_path.trim()
                ? input.project_path.trim()
                : project.directory,
            name: project.name,
          });
          const sections = asSections(input.sections);
          if (Object.keys(sections).length === 0 && typeof input.content === "string") {
            sections.Resumen = input.content.trim();
          }
          if (Object.keys(sections).length === 0) return fail("Incluye sections o content.");
          if (looksLikeSecret(JSON.stringify({ sections, related: input.related }))) {
            return fail("Rechazado: el contenido parece incluir un secreto o un dato privado.");
          }
          const title = input.title ? String(input.title).slice(0, 120) : null;
          const kind = typeof input.kind === "string" ? input.kind : defaultKind(entityKey);
          const tags = Array.isArray(input.tags) ? input.tags.map(String).slice(0, 10) : [];
          const related = Array.isArray(input.related) ? input.related.map(String).slice(0, 10) : [];
          const importance =
            typeof input.importance === "number" ? clamp(Math.round(input.importance), 1, 5) : 3;
          const lastVerifiedAt =
            typeof input.last_verified_at === "string" && !Number.isNaN(Date.parse(input.last_verified_at))
              ? new Date(input.last_verified_at).toISOString()
              : new Date().toISOString();
          const result = await upsertMemory(deps, {
            entityKey,
            scope: target.scope,
            projectId: target.projectId,
            projectPath: target.projectPath,
            kind,
            title,
            sections,
            tags,
            importance,
            pinned: input.pinned === true,
            related,
            reason: String(input.reason ?? "actualización"),
            lastVerifiedAt,
            sourceSession: String(context.sessionID),
          });
          const search = title ?? Object.values(sections)[0]?.slice(0, 80) ?? entityKey;
          const candidates = await similarCandidates(deps.query, search, result.id ?? null);
          return ok({
            action: result.action,
            id: result.id ?? null,
            existing_id: result.existingId ?? null,
            entity_key: entityKey,
            history_appended: result.historyAppended,
            candidates,
            last_verified_at: lastVerifiedAt,
          });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "memory_backup",
      description: "Crea una copia JSON de las memorias (y una fila en memory_backups) antes de consolidar o borrar.",
      input: {
        type: "object",
        properties: {
          label: { type: "string", maxLength: 120 },
          ids: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      async execute(input) {
        try {
          await deps.memory.prepare();
          const ids = Array.isArray(input.ids) ? input.ids.map(String) : undefined;
          const backup = await createBackup(deps, input.label ? String(input.label) : null, ids);
          return ok({ created: true, ...backup });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "memory_consolidation_plan",
      description:
        "Genera un plan dry-run de consolidación por entidad. Agrupa memorias, propone merged_content, conflictos y confianza; no modifica nada.",
      input: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          search: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
        },
        additionalProperties: false,
      },
      async execute(input) {
        try {
          await deps.memory.prepare();
          const ids = Array.isArray(input.ids) ? input.ids.map(String) : null;
          const search = typeof input.search === "string" ? input.search.trim() : "";
          const limit = typeof input.limit === "number" ? Math.round(input.limit) : 100;
          const values: unknown[] = [];
          let where = "deleted_at IS NULL";
          if (ids && ids.length > 0) {
            values.push(ids);
            where += ` AND id = ANY($${values.length}::uuid[])`;
          }
          if (search) {
            values.push(`%${search}%`);
            where += ` AND (title ILIKE $${values.length} OR content ILIKE $${values.length})`;
          }
          values.push(limit);
          const result = await deps.query<MemoryRow>(
            `SELECT id, scope, project_id, project_path, kind, title, content, tags,
                    importance, pinned, entity_key, doc, related, updated_at
             FROM memories WHERE ${where}
             ORDER BY updated_at DESC LIMIT $${values.length}`,
            values,
          );
          const rows = result.rows;
          const projectCounts = new Map<string, number>();
          for (const row of rows) {
            if (row.scope !== "project") continue;
            projectCounts.set(row.project_id, (projectCounts.get(row.project_id) ?? 0) + 1);
          }

          const clusters: MemoryRow[][] = [];
          for (const row of rows) {
            const rowTokens = tokensOf(`${row.title ?? ""} ${row.content}`);
            const target = clusters.find((cluster) => {
              const first = cluster[0]!;
              if (first.scope !== row.scope) return false;
              const firstIsDecision = first.kind === "decision";
              const rowIsDecision = row.kind === "decision";
              if (first.scope === "project") {
                if (firstIsDecision !== rowIsDecision) return false;
                const firstPath = first.project_path ?? first.project_id;
                const rowPath = row.project_path ?? row.project_id;
                if (!rowIsDecision) return firstPath === rowPath;
              }
              if (first.entity_key && row.entity_key) return first.entity_key === row.entity_key;
              if (firstIsDecision || rowIsDecision) {
                const firstSlug = slugify(first.title ?? first.content.slice(0, 60));
                const rowSlug = slugify(row.title ?? row.content.slice(0, 60));
                if (firstSlug && firstSlug === rowSlug) return true;
                return jaccard(tokensOf(first.title ?? first.content), rowTokens) >= 0.7;
              }
              return jaccard(tokensOf(`${first.title ?? ""} ${first.content}`), rowTokens) >= 0.6;
            });
            if (target) target.push(row);
            else clusters.push([row]);
          }

          const plan = clusters.map((cluster) => {
            const first = cluster.reduce((best, row) => {
              if (row.scope !== "project") return best;
              const diff = (projectCounts.get(row.project_id) ?? 0) - (projectCounts.get(best.project_id) ?? 0);
              if (diff > 0) return row;
              if (diff === 0 && new Date(iso(row.updated_at)) > new Date(iso(best.updated_at))) return row;
              return best;
            }, cluster[0]!);
            const entityKeys = [...new Set(cluster.map((row) => row.entity_key).filter(Boolean))] as string[];
            const titleSlug = slugify(first.title ?? first.content.slice(0, 60) ?? "memoria");
            const projectSlug = slugify(
              basename(first.project_path ?? first.project_id ?? "proyecto"),
            );
            let entityKey: string;
            if (entityKeys.length === 1) entityKey = entityKeys[0]!;
            else if (first.kind === "preference") entityKey = `preference:${titleSlug}`;
            else if (first.kind === "decision") entityKey = `decision:${titleSlug}`;
            else if (first.scope === "global") entityKey = `lesson:${titleSlug}`;
            else entityKey = `project:${projectSlug}`;

            const sections: SectionMap = {};
            const sectionDates = new Map<string, string>();
            const conflicts: Array<{ old: string; new: string; resolution: string }> = [];
            const sources: string[] = [];
            const historyLines = new Set<string>();
            const dropped: Array<{ fact: string; reason: string }> = [];
            const seen = new Set<string>();
            for (const row of [...cluster].sort(
              (left, right) => new Date(iso(right.updated_at)).getTime() - new Date(iso(left.updated_at)).getTime(),
            )) {
              const normalized = normalizeText(row.content);
              if (!normalized || normalized.length < 10) {
                dropped.push({ fact: row.content.slice(0, 120), reason: "trivial" });
                continue;
              }
              if (seen.has(normalized)) {
                dropped.push({ fact: row.content.slice(0, 120), reason: "duplicado" });
                continue;
              }
              seen.add(normalized);
              sources.push(`- ${iso(row.updated_at).slice(0, 10)} · ${row.title ?? row.id}`);
              const doc = asObject(row.doc);
              for (const entry of asHistory(doc.history)) {
                const line = `- ${entry.date.slice(0, 10)} · ${entry.section}: ${entry.reason || "cambio"}`;
                historyLines.add(entry.old ? `${line} (antes: ${entry.old.slice(0, 120)})` : line);
              }
              const rowSections = asSections(doc.sections);
              const fallbackKey = row.title
                ? `Nota: ${row.title}`
                : `Nota ${iso(row.updated_at).slice(0, 10)}`;
              const effectiveSections =
                Object.keys(rowSections).length > 0 ? rowSections : { [fallbackKey]: row.content };
              for (const [section, value] of Object.entries(effectiveSections)) {
                if (section === "Historial de cambios") {
                  for (const line of value.split("\n")) {
                    const clean = line.trim();
                    if (clean) historyLines.add(clean);
                  }
                  continue;
                }
                if (section === "Fuentes") continue;
                const old = sections[section];
                if (old && old.trim() !== value.trim()) {
                  const oldDate = sectionDates.get(section) ?? "";
                  const newDate = iso(row.updated_at);
                  conflicts.push({
                    old: `${oldDate.slice(0, 10)}: ${old.slice(0, 240)}`,
                    new: `${newDate.slice(0, 10)}: ${value.slice(0, 240)}`,
                    resolution:
                      oldDate && newDate
                        ? "prevalece la más reciente"
                        : "revisar manualmente: fechas no concluyentes",
                  });
                  if (newDate >= oldDate) {
                    sections[section] = value;
                    sectionDates.set(section, newDate);
                  }
                } else if (!old) {
                  sections[section] = value;
                  sectionDates.set(section, iso(row.updated_at));
                }
              }
            }
            if (conflicts.length > 0) {
              historyLines.add(
                `- ${new Date().toISOString().slice(0, 10)} · consolidación: ${conflicts.length} conflicto(s); prevalece la versión más reciente`,
              );
            }
            if (historyLines.size > 0) sections["Historial de cambios"] = [...historyLines].join("\n");
            if (sources.length > 0) sections.Fuentes = sources.join("\n");
            const mergedContent = renderSections(sections, []);
            const confidence =
              cluster.length === 1
                ? 0.9
                : conflicts.length > 0
                  ? 0.55
                  : entityKeys.length === 1
                    ? 0.9
                    : 0.75;
            return {
              entity_key: entityKey,
              action: cluster.length > 1 ? "merge" : "keep_separate",
              source_ids: cluster.map((row) => row.id),
              merged_content: mergedContent,
              dropped_facts: dropped,
              conflicts,
              confidence,
            };
          });

          return ok({ clusters: plan });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "memory_consolidation_apply",
      description:
        "Aplica un plan de consolidación aprobado: backup, upsert del documento, soft delete de originales, execution log y verificación posterior. Requiere confirmed=true; baja confianza o conflictos requieren approve_low_confidence=true.",
      input: {
        type: "object",
        properties: {
          plan: { type: "object", additionalProperties: true },
          confirmed: { type: "boolean", default: false },
          approve_low_confidence: { type: "boolean", default: false },
          verification_queries: { type: "array", items: { type: "string" } },
        },
        required: ["plan"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          await deps.memory.prepare();
          if (input.confirmed !== true) return ok({ applied: false, requires_confirmation: true });
          const plan = asObject(input.plan);
          const clusters = Array.isArray(plan.clusters) ? plan.clusters : [];
          if (clusters.length === 0) return fail("El plan no tiene clusters.");
          const risky = clusters.some((raw) => {
            const cluster = asObject(raw);
            const confidence = typeof cluster.confidence === "number" ? cluster.confidence : 1;
            const conflicts = Array.isArray(cluster.conflicts) ? cluster.conflicts : [];
            return confidence < 0.7 || conflicts.length > 0;
          });
          if (risky && input.approve_low_confidence !== true) {
            return ok({ applied: false, requires_approval: true, reason: "Hay clusters de baja confianza o con conflictos." });
          }
          const project = await deps.resolveProject(String(context.sessionID));
          const backup = await createBackup(deps, "consolidación de memoria");
          const executionId = await deps.mam.store.startExecution({
            projectId: project.projectId,
            agentId: "memory-consolidator",
            role: "memory-consolidation",
            mode: "manual",
            selectionReason: "consolidación aprobada por el usuario",
            toolVersions: { node: process.version },
            metadata: { backup_id: backup.id, clusters: clusters.length },
          });
          let merged = 0;
          let archived = 0;
          let kept = 0;
          const errors: string[] = [];
          for (const raw of clusters) {
            const cluster = asObject(raw);
            const action = String(cluster.action ?? "keep_separate");
            const sourceIds = Array.isArray(cluster.source_ids) ? cluster.source_ids.map(String) : [];
            if (action === "keep_separate" || sourceIds.length === 0) {
              kept += 1;
              continue;
            }
            if (action === "archive") {
              await deps.query(
                `UPDATE memories SET deleted_at = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
                [sourceIds],
              );
              archived += sourceIds.length;
              continue;
            }
            if (action !== "merge") {
              kept += 1;
              continue;
            }
            try {
              const sources = (
                await deps.query<MemoryRow>(
                  `SELECT id, scope, project_id, project_path, kind, title, content, tags,
                          importance, pinned, entity_key, doc, related, updated_at
                   FROM memories WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
                  [sourceIds],
                )
              ).rows;
              if (sources.length === 0) continue;
              const scopes = new Set(sources.map((row) => row.scope));
              if (scopes.size > 1) {
                errors.push(`Cluster ${String(cluster.entity_key)} mezcla scopes; se deja separado.`);
                kept += 1;
                continue;
              }
              const paths = new Set(
                sources
                  .filter((row) => row.scope === "project")
                  .map((row) => row.project_path ?? row.project_id),
              );
              if (paths.size > 1) {
                errors.push(`Cluster ${String(cluster.entity_key)} mezcla proyectos; se deja separado.`);
                kept += 1;
                continue;
              }
              const projectCounts = new Map<string, number>();
              for (const source of sources) {
                if (source.scope !== "project") continue;
                projectCounts.set(source.project_id, (projectCounts.get(source.project_id) ?? 0) + 1);
              }
              const first = sources.reduce((best, row) => {
                if (row.scope !== "project") return best;
                const diff = (projectCounts.get(row.project_id) ?? 0) - (projectCounts.get(best.project_id) ?? 0);
                if (diff > 0) return row;
                if (diff === 0 && new Date(iso(row.updated_at)) > new Date(iso(best.updated_at))) return row;
                return best;
              }, sources[0]!);
              const entityKey = String(cluster.entity_key ?? first.entity_key ?? "");
              if (!ENTITY_RE.test(entityKey)) {
                errors.push(`entity_key inválido en cluster: ${entityKey}`);
                continue;
              }
              const sections = parseSectionsFromContent(String(cluster.merged_content ?? ""));
              const tags = [...new Set(sources.flatMap((row) => row.tags ?? []))];
              const related = [...new Set(sources.flatMap((row) => row.related ?? []))];
              const result = await upsertMemory(deps, {
                entityKey,
                scope: first.scope,
                projectId: first.project_id,
                projectPath: first.project_path,
                kind: first.kind,
                title: entityKey.startsWith("project:")
                  ? basename(first.project_path ?? entityKey.slice("project:".length))
                  : first.title,
                sections,
                tags,
                importance: Math.max(...sources.map((row) => row.importance ?? 3)),
                pinned: sources.some((row) => row.pinned),
                related,
                reason: "consolidación de memorias",
                lastVerifiedAt: new Date().toISOString(),
                sourceSession: String(context.sessionID),
                replaceSections: entityKey.startsWith("project:"),
              });
              if (result.action === "conflict" || !result.id) {
                errors.push(`Conflicto al consolidar ${entityKey}.`);
                continue;
              }
              await deps.query(
                `UPDATE memories SET deleted_at = now(), merged_into = $1
                 WHERE id = ANY($2::uuid[]) AND id <> $1 AND deleted_at IS NULL`,
                [result.id, sourceIds],
              );
              merged += 1;
            } catch (error) {
              errors.push(error instanceof Error ? error.message : String(error));
            }
          }
          const verificationQueries = Array.isArray(input.verification_queries)
            ? input.verification_queries.map(String).slice(0, 10)
            : clusters
                .map((raw) => String(asObject(raw).entity_key ?? ""))
                .filter(Boolean)
                .slice(0, 10);
          const verification = await verifyMemories(deps.query, verificationQueries);
          await deps.mam.store.finishExecution(executionId, {
            status: errors.length > 0 ? "failed" : "done",
            error: errors.length > 0 ? errors.join(" · ").slice(0, 1_000) : null,
            metadata: { backup_id: backup.id, merged, archived, kept, errors, verification },
          });
          return ok({
            applied: true,
            backup,
            merged,
            archived,
            kept,
            errors,
            execution_id: executionId,
            verification,
          });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "memory_consolidation_verify",
      description: "Verifica que la información consolidada sigue apareciendo con 5-10 consultas reales de búsqueda textual.",
      input: {
        type: "object",
        properties: {
          queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
          entity_keys: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      async execute(input) {
        try {
          await deps.memory.prepare();
          const queries = Array.isArray(input.queries)
            ? input.queries.map(String)
            : Array.isArray(input.entity_keys)
              ? input.entity_keys.map(String)
              : [];
          if (queries.length === 0) return fail("Incluye queries o entity_keys.");
          if (queries.length > 10) return fail("Máximo 10 consultas de verificación.");
          const verification = await verifyMemories(deps.query, queries);
          return ok({ count: queries.length, verification });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

async function verifyMemories(
  query: QueryFn,
  queries: string[],
): Promise<Array<{ query: string; matches: Array<{ id: string; entity_key: string | null; title: string | null; updated_at: string }> }>> {
  const result: Array<{
    query: string;
    matches: Array<{ id: string; entity_key: string | null; title: string | null; updated_at: string }>;
  }> = [];
  for (const raw of queries.slice(0, 10)) {
    const value = raw.trim();
    if (!value) continue;
    const rows = await query<{
      id: string;
      entity_key: string | null;
      title: string | null;
      updated_at: Date | string;
    }>(
      `SELECT id, entity_key, title, updated_at FROM memories
       WHERE deleted_at IS NULL
         AND (entity_key = $1 OR title ILIKE $2 OR content ILIKE $2)
       ORDER BY updated_at DESC LIMIT 5`,
      [value, `%${value}%`],
    );
    result.push({
      query: value,
      matches: rows.rows.map((row) => ({
        id: row.id,
        entity_key: row.entity_key,
        title: row.title,
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      })),
    });
  }
  return result;
}
