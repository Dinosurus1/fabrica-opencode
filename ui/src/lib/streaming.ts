/**
 * Streaming incremental de OpenCode V2.
 *
 * El API emite `session.text.delta` / `session.reasoning.delta` con
 * `{ sessionID, assistantMessageID, ordinal, delta }`. Antes la consola
 * refrescaba todo el contexto cada segundo; ahora acumula los deltas en
 * memoria y los fusiona con el último contexto conocido. El contexto completo
 * sigue siendo la fuente de verdad: cuando llega el mensaje final, el buffer
 * se descarta.
 */
import type { LiveEvent } from "./events";
import type { MessagePart, SessionMessage } from "./types";

export interface StreamEntry {
  sessionId: string;
  messageID: string;
  createdAt: number;
  text: Map<number, string>;
  reasoning: Map<number, string>;
}

export type StreamState = Record<string, StreamEntry>;

const STREAM_EVENT = /^session\.(text|reasoning)\.(started|delta|ended)$/;

function eventData(event: LiveEvent): Record<string, unknown> {
  return (event.data ?? {}) as Record<string, unknown>;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function entryKey(sessionId: string, messageID: string): string {
  return `${sessionId}:${messageID}`;
}

function cloneEntry(entry: StreamEntry): StreamEntry {
  return {
    ...entry,
    text: new Map(entry.text),
    reasoning: new Map(entry.reasoning),
  };
}

function joinParts(parts: Map<number, string>): string {
  return [...parts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
    .join("");
}

/** Aplica un evento de streaming. Ignora eventos que no son deltas de sesión. */
export function applyStreamEvent(state: StreamState, event: LiveEvent): StreamState {
  const data = eventData(event);
  const sessionId = typeof data.sessionID === "string" ? data.sessionID : "";

  if (event.type === "session.deleted") {
    if (!sessionId) return state;
    const next: StreamState = {};
    for (const [key, entry] of Object.entries(state)) {
      if (entry.sessionId !== sessionId) next[key] = entry;
    }
    return next;
  }

  const match = STREAM_EVENT.exec(event.type);
  if (!match) return state;
  const messageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : "";
  if (!sessionId || !messageID) return state;

  const kind = match[1] as "text" | "reasoning";
  const phase = match[2];
  const key = entryKey(sessionId, messageID);
  const current = state[key] ? cloneEntry(state[key]) : {
    sessionId,
    messageID,
    createdAt: asNumber(event.created, Date.now()),
    text: new Map<number, string>(),
    reasoning: new Map<number, string>(),
  };

  const ordinal = asNumber(data.ordinal, 0);
  if (phase === "delta" && typeof data.delta === "string") {
    current[kind].set(ordinal, `${current[kind].get(ordinal) ?? ""}${data.delta}`);
  } else if (!current[kind].has(ordinal)) {
    current[kind].set(ordinal, "");
  }

  return { ...state, [key]: current };
}

function partsFor(entry: StreamEntry): MessagePart[] {
  const reasoning = joinParts(entry.reasoning);
  const text = joinParts(entry.text);
  return [
    ...(reasoning ? [{ type: "reasoning", text: reasoning }] : []),
    ...(text ? [{ type: "text", text }] : []),
  ];
}

/**
 * Fusiona el buffer con los mensajes del contexto. Si el mensaje ya existe, se
 * sustituyen solo sus partes de texto/razonamiento; las tools se conservan.
 * Los mensajes que aún no han llegado al contexto se añaden al final.
 */
export function mergeStreamMessages(
  messages: SessionMessage[],
  state: StreamState,
  sessionId: string | null,
): SessionMessage[] {
  if (!sessionId) return messages;
  const entries = Object.values(state).filter((entry) => entry.sessionId === sessionId);
  if (entries.length === 0) return messages;

  const pending = new Map(entries.map((entry) => [entry.messageID, entry]));
  const merged = messages.map((message) => {
    const entry = pending.get(message.id);
    if (!entry) return message;
    pending.delete(message.id);
    const parts = partsFor(entry);
    if (parts.length === 0) return message;
    const others = (message.content ?? []).filter(
      (part) => part.type !== "text" && part.type !== "reasoning",
    );
    return {
      ...message,
      text: parts.find((part) => part.type === "text")?.text ?? message.text,
      content: [...parts, ...others],
    };
  });

  for (const entry of [...pending.values()].sort((left, right) => left.createdAt - right.createdAt)) {
    const parts = partsFor(entry);
    if (parts.length === 0) continue;
    merged.push({
      id: entry.messageID,
      type: "assistant",
      text: parts.find((part) => part.type === "text")?.text,
      content: parts,
      time: { created: entry.createdAt },
    });
  }

  return merged;
}

/**
 * Descarta los buffers cuyo mensaje final ya está en el contexto. Se llama solo
 * cuando la sesión ya no está trabajando para no perder texto en curso.
 */
export function clearSettledStreams(
  state: StreamState,
  sessionId: string,
  messages: SessionMessage[],
): StreamState {
  const present = new Set(
    messages
      .filter((message) => message.type === "assistant" && messageTextLength(message) > 0)
      .map((message) => message.id),
  );
  let changed = false;
  const next: StreamState = {};
  for (const [key, entry] of Object.entries(state)) {
    if (entry.sessionId === sessionId && present.has(entry.messageID)) {
      changed = true;
      continue;
    }
    next[key] = entry;
  }
  return changed ? next : state;
}

/** Limpia todos los buffers de una sesión (al borrarla o al cerrar). */
export function clearSessionStreams(state: StreamState, sessionId: string): StreamState {
  let changed = false;
  const next: StreamState = {};
  for (const [key, entry] of Object.entries(state)) {
    if (entry.sessionId === sessionId) {
      changed = true;
      continue;
    }
    next[key] = entry;
  }
  return changed ? next : state;
}

function messageTextLength(message: SessionMessage): number {
  const fromParts = (message.content ?? [])
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("");
  return (fromParts || message.text || "").trim().length;
}
