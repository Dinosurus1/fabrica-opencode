/**
 * Traspaso estructurado entre sesiones.
 *
 * Principios:
 * - El último pedido del usuario se copia completo; nunca se resume ni se
 *   trunca.
 * - Si el último mensaje ya es un traspaso, se extrae su sección textual en
 *   lugar de resumir el resumen (no se anidan traspasos).
 * - El repo es la fuente de verdad para rama, commit y archivos.
 * - La memoria persistente aporta decisiones; no sustituye al historial.
 */
import { baseTitle } from "./lineage";
import type { RepoStatus, Session, SessionMessage } from "./types";

export type HandoffSection =
  | "objective"
  | "lastRequest"
  | "lastAssistant"
  | "done"
  | "doing"
  | "pending"
  | "decisions"
  | "repo"
  | "bugs"
  | "constraints";

export interface HandoffInput {
  session: Session;
  messages: SessionMessage[];
  repo?: RepoStatus | null;
  decisions?: string[];
  objective?: string;
  pinned?: HandoffSection[];
}

export interface Handoff {
  objective: string;
  lastRequest: string;
  lastAssistant: string;
  done: string[];
  doing: string[];
  pending: string[];
  decisions: string[];
  files: string[];
  branch: string;
  lastCommit: string;
  repoOk: boolean;
  bugs: string[];
  constraints: string[];
  text: string;
  tokens: number;
  dropped: string[];
  truncated: boolean;
  pinned: HandoffSection[];
}

export const DEFAULT_CONSTRAINTS = [
  "No exponer la consola a Internet sin autenticación.",
  "No subir claves, tokens, `.env`, URLs privadas ni datos del tailnet al repositorio ni a la memoria.",
  "Pedir OK antes de iniciar una fase o cambiar el alcance.",
  "Responder en español y distinguir lo verificado de lo esperado.",
];

const DROPPED = [
  "Salidas largas de herramientas que ya no aportan al objetivo.",
  "Archivos grandes ya leídos y repetidos en varios turnos.",
  "Mensajes antiguos que no contienen decisiones, restricciones ni pedidos.",
];

const MAX_ASSISTANT = 4_000;

function textOf(message: SessionMessage): string {
  const parts = (message.content ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!.trim())
    .filter(Boolean);
  return (parts.join("\n") || message.text || "").trim();
}

function asUser(message: SessionMessage): boolean {
  return message.type === "user" && Boolean(textOf(message));
}

function asAssistant(message: SessionMessage): boolean {
  return message.type === "assistant" && Boolean(textOf(message));
}

function lastOf(messages: SessionMessage[], predicate: (message: SessionMessage) => boolean): SessionMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) return messages[index];
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extrae una sección Markdown `## Título` hasta el siguiente encabezado. */
export function extractSection(text: string, names: string[]): string {
  const lines = text.split("\n");
  const matchers = names.map(
    (name) => new RegExp(`^#{1,4}\\s*${escapeRegExp(name)}\\s*$`, "i"),
  );
  const start = lines.findIndex((line) => matchers.some((matcher) => matcher.test(line.trim())));
  if (start < 0) return "";
  const result: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,4}\s+/.test(lines[index])) break;
    result.push(lines[index]);
  }
  return result.join("\n").trim();
}

function listFrom(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\[[ xX]\]\s*/, "").trim())
    .filter(Boolean);
}

function unique(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const clean = item.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
    if (result.length >= limit) break;
  }
  return result;
}

function checklistFrom(text: string): { done: string[]; doing: string[]; pending: string[] } {
  const done = listFrom(extractSection(text, ["Hecho", "Completado", "Done"]));
  const doing = listFrom(extractSection(text, ["En curso", "En progreso", "Doing"]));
  const pending = listFrom(extractSection(text, ["Pendiente", "Pendientes", "Todo"]));
  if (done.length || doing.length || pending.length) {
    return { done, doing, pending };
  }
  const checked = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[[xX ]\]\s+/.test(line));
  return {
    done: checked.filter((line) => /\[[xX]\]/.test(line)).map((line) => line.replace(/^[-*]\s+\[[xX]\]\s*/, "").trim()),
    doing: [],
    pending: checked.filter((line) => /\[ \]/.test(line)).map((line) => line.replace(/^[-*]\s+\[ \]\s*/, "").trim()),
  };
}

function bugsFrom(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\b(bug|falla|fallo|error|roto|pendiente|pendientes)\b/i.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .slice(0, 12);
}

function cleanObjective(value: string): string {
  return value
    .replace(/^Continuación de la sesión\s+«[^»]*»\s*\([^)]*\)\.?\s*/i, "")
    .replace(/^Continuación de la sesión\s+[^.]*\.\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

function repoLines(repo?: RepoStatus | null): {
  branch: string;
  lastCommit: string;
  files: string[];
  ok: boolean;
} {
  if (!repo) return { branch: "no verificado", lastCommit: "no verificado", files: [], ok: false };
  if (!repo.ok) {
    return { branch: "no disponible", lastCommit: repo.error ?? "no disponible", files: [], ok: false };
  }
  return {
    branch: repo.branch || "(detached)",
    lastCommit: repo.last_commit || "—",
    files: repo.dirty ?? [],
    ok: true,
  };
}

export function buildHandoff(input: HandoffInput): Handoff {
  const { session, messages } = input;
  const userMessages = messages.filter(asUser);
  const lastUser = lastOf(messages, asUser);
  const lastAssistant = lastOf(messages, asAssistant);
  const lastUserText = lastUser ? textOf(lastUser) : "";
  const lastAssistantFull = lastAssistant ? textOf(lastAssistant) : "";
  const lastAssistantText =
    lastAssistantFull.length > MAX_ASSISTANT
      ? `${lastAssistantFull.slice(0, MAX_ASSISTANT)}\n\n[… recortado a ${MAX_ASSISTANT} caracteres; la transcripción completa sigue en la sesión original.]`
      : lastAssistantFull;

  const objectiveFromHandoff = extractSection(lastUserText, ["Objetivo", "Objetivo actual"]);
  const objective =
    cleanObjective(input.objective ?? "") ||
    cleanObjective(objectiveFromHandoff) ||
    baseTitle(session.title) ||
    cleanObjective(textOf(userMessages[0] ?? { id: "", type: "user" })) ||
    "Sesión sin objetivo explícito";

  const lastRequestFromHandoff = extractSection(lastUserText, ["Último pedido (textual)", "Último pedido", "Pedido actual"]);
  const lastRequest =
    lastRequestFromHandoff ||
    (lastUserText.includes("## Objetivo") ? objectiveFromHandoff : lastUserText) ||
    "—";

  const previousChecklist = checklistFrom(lastUserText);
  const currentChecklist = checklistFrom(lastAssistantText);
  const done = unique(
    [...previousChecklist.done, ...currentChecklist.done],
    12,
  );
  const doing = unique([...previousChecklist.doing, ...currentChecklist.doing], 12);
  const pending = unique([...previousChecklist.pending, ...currentChecklist.pending], 12);

  const decisions = unique(
    [
      ...(input.decisions ?? []),
      ...listFrom(extractSection(lastUserText, ["Decisiones", "Decisiones relevantes"])),
    ],
    12,
  );
  const constraints = unique(
    [
      ...DEFAULT_CONSTRAINTS,
      ...listFrom(extractSection(lastUserText, ["Restricciones vigentes", "Restricciones"])),
    ],
    12,
  );
  const bugs = unique(
    [
      ...listFrom(extractSection(lastUserText, ["Bugs abiertos", "Bugs"])),
      ...bugsFrom(lastAssistantText),
    ],
    8,
  );
  const repo = repoLines(input.repo);

  const section = (title: string, body: string) => `## ${title}\n${body.trim() || "—"}`;
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "—");
  const text = [
    "# Traspaso de sesión",
    section("Objetivo", objective),
    section("Último pedido (textual)", lastRequest),
    section("Último estado del asistente", lastAssistantText),
    section("Hecho", list(done)),
    section("En curso", list(doing)),
    section("Pendiente", list(pending)),
    section("Decisiones", list(decisions)),
    section(
      "Repositorio",
      [
        `- Rama: ${repo.branch}`,
        `- Último commit: ${repo.lastCommit}`,
        `- Archivos con cambios: ${repo.files.length ? repo.files.slice(0, 20).join(", ") : repo.ok ? "ninguno" : "no verificado"}`,
      ].join("\n"),
    ),
    section("Bugs abiertos", list(bugs)),
    section("Restricciones vigentes", list(constraints)),
    section("Qué se deja fuera", list(DROPPED)),
    "Al abrir esta sesión, confirma en 5 líneas qué entendiste (objetivo, hecho/pendiente, restricciones) antes de actuar. Si algo no coincide con el repositorio o la memoria, dilo y corrige el traspaso.",
  ].join("\n\n");

  const tokens = estimateTokens(text);
  return {
    objective,
    lastRequest,
    lastAssistant: lastAssistantText,
    done,
    doing,
    pending,
    decisions,
    files: repo.files,
    branch: repo.branch,
    lastCommit: repo.lastCommit,
    repoOk: repo.ok,
    bugs,
    constraints,
    text,
    tokens,
    dropped: DROPPED,
    truncated: lastAssistantFull.length > MAX_ASSISTANT || tokens > 6_000,
    pinned: input.pinned ?? [],
  };
}

export function formatRepoStatus(repo: RepoStatus, extra?: string): string {
  if (!repo.ok) return `${extra ? `${extra}\n\n` : ""}Repositorio: ${repo.error ?? "no disponible"}`;
  const lines = [
    `Rama: ${repo.branch || "(detached)"}`,
    `Último commit: ${repo.last_commit || "—"}`,
    `Estado: ${repo.dirty?.length ? `${repo.dirty.length} archivo(s) con cambios` : "limpio"}`,
    ...(repo.dirty?.length ? repo.dirty.slice(0, 30).map((file) => `- ${file}`) : []),
  ];
  return `${extra ? `${extra}\n\n` : ""}${lines.join("\n")}`;
}

const CHECKPOINT_PREFIX = "factory.sessions.checkpoint.";

const PIN_LINE = "> Elementos fijados:";

export const HANDOFF_SECTION_LABELS: Record<HandoffSection, string> = {
  objective: "Objetivo",
  lastRequest: "Último pedido",
  lastAssistant: "Último estado",
  done: "Hecho",
  doing: "En curso",
  pending: "Pendiente",
  decisions: "Decisiones",
  repo: "Repositorio",
  bugs: "Bugs abiertos",
  constraints: "Restricciones",
};

/** Marca las secciones que el usuario quiere fijar sin reescribir el traspaso. */
export function applyPinnedSections(text: string, pinned: HandoffSection[]): string {
  const lines = text.split("\n");
  const without = lines.filter((line) => !line.trim().startsWith(PIN_LINE));
  if (pinned.length === 0) return without.join("\n");
  const labels = pinned.map((section) => HANDOFF_SECTION_LABELS[section]).filter(Boolean);
  if (labels.length === 0) return without.join("\n");
  const insertAt = Math.min(1, without.length);
  const pin = `${PIN_LINE} ${labels.join(", ")}. No omitirlos al continuar.`;
  return [...without.slice(0, insertAt), pin, ...without.slice(insertAt)].join("\n");
}


export interface Checkpoint {
  text: string;
  tokens: number;
  objective: string;
  createdAt: number;
}

export function saveCheckpoint(sessionId: string, handoff: Handoff): Checkpoint {
  const checkpoint: Checkpoint = {
    text: handoff.text,
    tokens: handoff.tokens,
    objective: handoff.objective,
    createdAt: Date.now(),
  };
  try {
    localStorage.setItem(`${CHECKPOINT_PREFIX}${sessionId}`, JSON.stringify(checkpoint));
  } catch {
    // Sin localStorage el checkpoint no persiste; el traspaso sigue en el modal.
  }
  return checkpoint;
}

export function readCheckpoint(sessionId: string): Checkpoint | null {
  try {
    const raw = localStorage.getItem(`${CHECKPOINT_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Checkpoint>;
    if (typeof parsed.text !== "string") return null;
    return {
      text: parsed.text,
      tokens: typeof parsed.tokens === "number" ? parsed.tokens : estimateTokens(parsed.text),
      objective: typeof parsed.objective === "string" ? parsed.objective : "",
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
    };
  } catch {
    return null;
  }
}
