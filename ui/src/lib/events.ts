import { useEffect, useRef, useState } from "react";

export interface LiveEvent {
  id?: string | null;
  type: string;
  created?: number;
  data: Record<string, unknown>;
  durable?: { aggregateID?: string; seq?: number };
}

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

/**
 * Eventos que necesita el apartado de sesiones. Suscribirse solo a estos evita
 * recibir ruido (sistema de ficheros, PTY, MCP…) sin perder nada de la sesión.
 */
const SESSION_EVENT_TYPES = [
  "session.created",
  "session.renamed",
  "session.deleted",
  "session.archived",
  "session.unarchived",
  "session.moved",
  "session.forked",
  "session.agent.selected",
  "session.model.selected",
  "session.usage.updated",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.status",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.retry.scheduled",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
];

const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * Consume el stream SSE de OpenCode (`/api/event`) a través del proxy de la
 * consola. EventSource reconecta solo, pero forzamos una conexión nueva cuando
 * el stream queda cerrado y resincronizamos al volver a la pestaña.
 */
export function useSessionEvents(onEvent: (event: LiveEvent) => void) {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let attempt = 0;
    let filtered = true;
    let everOpened = false;

    const connect = () => {
      if (closed) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (source) {
        source.close();
        source = null;
      }
      const params = new URLSearchParams();
      for (const type of SESSION_EVENT_TYPES) params.append("types", type);
      const next = new EventSource(filtered ? `/api/event?${params.toString()}` : "/api/event");
      source = next;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");

      next.onopen = () => {
        everOpened = true;
        attempt = 0;
        setStatus("live");
      };

      next.onmessage = (message) => {
        if (!message.data) return;
        try {
          const parsed = JSON.parse(message.data) as LiveEvent;
          handlerRef.current(parsed);
        } catch {
          // Un evento ilegible no debe tumbar el stream.
        }
      };

      next.onerror = () => {
        if (closed) return;
        setStatus(next.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
        if (next.readyState !== EventSource.CLOSED) return;
        next.close();
        void fetch("/auth/session", { signal: AbortSignal.timeout(3000) })
          .then((response) => response.json())
          .then((value: { authenticated?: boolean }) => {
            if (value?.authenticated === false) {
              window.dispatchEvent(new CustomEvent("factory:unauthorized"));
            }
          })
          .catch(() => {
            // Sin red: el reintento normal se encarga.
          });
        // Si el filtro de tipos no llega a abrir (por ejemplo, un evento
        // renombrado en una versión nueva), se reintenta sin filtro.
        if (!everOpened && filtered) {
          filtered = false;
          attempt = 0;
          retryTimer = setTimeout(connect, 250);
          return;
        }
        attempt += 1;
        const delay = RECONNECT_DELAYS[Math.min(attempt - 1, RECONNECT_DELAYS.length - 1)];
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    const onVisibility = () => {
      if (document.visibilityState !== "visible" || closed) return;
      if (source && source.readyState !== EventSource.CLOSED) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempt = 0;
      connect();
    };

    const onOnline = () => {
      if (closed) return;
      if (source && source.readyState !== EventSource.CLOSED) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempt = 0;
      connect();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  return { status };
}

/** Sesiones cuya ejecución está en marcha (según el stream o la API). */
export function runningSessionIds(
  active: Record<string, { type?: string }> | undefined,
  sessions: Array<{ id: string; time: { busy?: number; idle?: number } }>,
): Set<string> {
  const running = new Set<string>();
  for (const [id, state] of Object.entries(active ?? {})) {
    if (state?.type === "running") running.add(id);
  }
  for (const session of sessions) {
    if ((session.time.busy ?? 0) > (session.time.idle ?? 0)) running.add(session.id);
  }
  return running;
}
