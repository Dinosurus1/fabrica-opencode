/**
 * Linaje de sesiones en el navegador (MVP de la etapa 1).
 *
 * El linaje vive en `localStorage`: no se sincroniza entre dispositivos hasta
 * la etapa 2, cuando se persista en PostgreSQL. La interfaz debe avisarlo.
 */
export interface LineageEntry {
  rootId: string;
  parentId: string | null;
  generation: number;
  title: string;
  createdAt: number;
}

export type LineageMap = Record<string, LineageEntry>;

const STORAGE_KEY = "factory.sessions.lineage";
const CONTINUATION_PREFIX = "Continuación · ";

export function baseTitle(title?: string): string {
  let value = (title ?? "").trim();
  while (value.startsWith(CONTINUATION_PREFIX)) {
    value = value.slice(CONTINUATION_PREFIX.length).trim();
  }
  return value;
}

/** Cuenta cuántas continuaciones anidadas tiene un título antiguo. */
export function generationFromTitle(title?: string): number {
  let value = (title ?? "").trim();
  let count = 0;
  while (value.startsWith(CONTINUATION_PREFIX)) {
    count += 1;
    value = value.slice(CONTINUATION_PREFIX.length).trim();
  }
  return count;
}

export function titleForHandoff(objective: string, generation: number): string {
  const clean = objective.replace(/\s+/g, " ").trim() || "Sesión";
  const short = clean.length > 56 ? `${clean.slice(0, 55).trim()}…` : clean;
  return `${short} · parte ${generation + 1}`;
}

export function loadLineage(): LineageMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: LineageMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<LineageEntry>;
      if (typeof entry.rootId !== "string" || typeof entry.generation !== "number") continue;
      result[key] = {
        rootId: entry.rootId,
        parentId: typeof entry.parentId === "string" ? entry.parentId : null,
        generation: Math.max(0, Math.round(entry.generation)),
        title: typeof entry.title === "string" ? entry.title : key,
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
      };
    }
    return result;
  } catch {
    return {};
  }
}

function saveLineage(map: LineageMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Sin localStorage el linaje sigue en memoria durante la sesión actual.
  }
}

export function lineageFor(sessionId: string): LineageEntry | null {
  return loadLineage()[sessionId] ?? null;
}

/** Registra una sesión como raíz si aún no tiene entrada. */
export function ensureRoot(sessionId: string, title?: string): LineageEntry {
  const map = loadLineage();
  const existing = map[sessionId];
  if (existing) return existing;
  const entry: LineageEntry = {
    rootId: sessionId,
    parentId: null,
    generation: generationFromTitle(title),
    title: baseTitle(title) || sessionId,
    createdAt: Date.now(),
  };
  map[sessionId] = entry;
  saveLineage(map);
  return entry;
}

/**
 * Registra la hija de una sesión. `generation` es el número de continuaciones:
 * una raíz es 0 y la primera hija es 1.
 */
export function registerChild(
  parentId: string,
  parentTitle: string | undefined,
  childId: string,
  objective: string,
  title?: string,
): LineageEntry {
  const map = loadLineage();
  const parent = map[parentId] ?? ensureRoot(parentId, parentTitle);
  map[parentId] = parent;
  const generation = parent.generation + 1;
  const entry: LineageEntry = {
    rootId: parent.rootId,
    parentId,
    generation,
    title: title?.trim() || titleForHandoff(objective, generation),
    createdAt: Date.now(),
  };
  map[childId] = entry;
  saveLineage(map);
  return entry;
}

/** Cadena raíz → … → sesión. */
export function lineageChain(sessionId: string): LineageEntry[] {
  const map = loadLineage();
  const chain: LineageEntry[] = [];
  let current = map[sessionId];
  const seen = new Set<string>();
  while (current && !seen.has(current.rootId + current.title + current.generation)) {
    chain.push(current);
    seen.add(current.rootId + current.title + current.generation);
    if (!current.parentId) break;
    current = map[current.parentId];
  }
  return chain.reverse();
}

export function childrenOf(sessionId: string): LineageEntry[] {
  const map = loadLineage();
  return Object.values(map).filter((entry) => entry.parentId === sessionId);
}

export function generationForChild(parentId: string, parentTitle?: string): number {
  const parent = lineageFor(parentId) ?? ensureRoot(parentId, parentTitle);
  return parent.generation + 1;
}
