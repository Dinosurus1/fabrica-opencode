import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleStop,
  Loader2,
  MessageSquarePlus,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useMemo } from "react";
import { cn, modelLabel, shortPath } from "../../lib/format";
import type { Session } from "../../lib/types";

interface SessionListProps {
  sessions: Session[];
  runningIds: Set<string>;
  attentionIds?: Set<string>;
  selectedId: string | null;
  loading: boolean;
  liveLabel: string;
  liveTone: "live" | "connecting" | "offline";
  query: string;
  onQueryChange: (value: string) => void;
  onlyProject: boolean;
  onOnlyProjectChange: (value: boolean) => void;
  showSubagents: boolean;
  onShowSubagentsChange: (value: boolean) => void;
  onSelect: (id: string) => void;
  onDelete: (session: Session) => void;
  onNewChat: () => void;
  onRetry?: () => void;
  error?: unknown;
  projectLabel?: string;
}

const GROUPS = ["Hoy", "Ayer", "Últimos 7 días", "Este mes", "Anteriores"] as const;

function groupOf(timestamp: number): (typeof GROUPS)[number] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday) return "Hoy";
  if (timestamp >= startOfToday - 86_400_000) return "Ayer";
  if (timestamp >= startOfToday - 6 * 86_400_000) return "Últimos 7 días";
  if (timestamp >= new Date(now.getFullYear(), now.getMonth(), 1).getTime()) return "Este mes";
  return "Anteriores";
}

function listTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 60_000) return "ahora";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min`;
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" }).format(date);
}

function modelShort(session: Session): string {
  const id = session.model?.id ?? "";
  return id.replace(/^.*\//, "") || modelLabel(session.model?.providerID, session.model?.id);
}

function OutcomeIcon({ outcome }: { outcome?: string }) {
  if (outcome === "failed") return <CircleAlert size={12} className="shrink-0 text-danger" />;
  if (outcome === "interrupted") return <CircleStop size={12} className="shrink-0 text-warning" />;
  if (outcome === "succeeded") return <CircleCheck size={12} className="shrink-0 text-success/70" />;
  return null;
}

export function SessionList({
  sessions,
  runningIds,
  attentionIds,
  selectedId,
  loading,
  liveLabel,
  liveTone,
  query,
  onQueryChange,
  onlyProject,
  onOnlyProjectChange,
  showSubagents,
  onShowSubagentsChange,
  onSelect,
  onDelete,
  onNewChat,
  onRetry,
  error,
  projectLabel,
}: SessionListProps) {
  const groups = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of sessions) {
      const key = groupOf(session.time.updated);
      const list = map.get(key) ?? [];
      list.push(session);
      map.set(key, list);
    }
    return GROUPS.flatMap((label) => {
      const items = map.get(label);
      return items?.length ? [{ label, items }] : [];
    });
  }, [sessions]);

  const dotClass =
    liveTone === "live"
      ? "bg-success"
      : liveTone === "connecting"
        ? "bg-warning"
        : "bg-danger";

  const attentionCount = useMemo(
    () => sessions.filter((session) => attentionIds?.has(session.id)).length,
    [sessions, attentionIds],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line-soft px-3 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-[-0.01em] text-ink">Sesiones</h1>
            <p className="text-[10px] text-faint">
              {sessions.length} {sessions.length === 1 ? "conversación" : "conversaciones"}
              {attentionCount > 0
                ? ` · ${attentionCount} ${
                    attentionCount === 1 ? "necesita" : "necesitan"
                  } tu intervención`
                : ""}
            </p>
          </div>
          <button
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-violet/40 bg-violet/15 px-2.5 text-[11px] font-medium text-violet-soft transition-colors hover:bg-violet/25"
            onClick={onNewChat}
            title="Nuevo chat"
          >
            <MessageSquarePlus size={13} /> Nuevo
          </button>
        </div>

        <label className="mt-2.5 flex h-8 items-center gap-2 rounded-lg border border-line bg-carbon-950 px-2.5 focus-within:border-violet/60">
          <Search size={13} className="shrink-0 text-faint" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Buscar conversación"
            className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-faint"
          />
          {query ? (
            <button
              onClick={() => onQueryChange("")}
              className="rounded p-0.5 text-faint hover:text-ink"
              aria-label="Limpiar búsqueda"
            >
              <X size={12} />
            </button>
          ) : null}
        </label>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
              onlyProject
                ? "border-violet/40 bg-violet/15 text-violet-soft"
                : "border-line bg-carbon-900 text-muted hover:text-ink",
            )}
            onClick={() => onOnlyProjectChange(!onlyProject)}
            title="Limitar a las sesiones del proyecto activo"
          >
            Solo este proyecto
          </button>
          <button
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
              showSubagents
                ? "border-violet/40 bg-violet/15 text-violet-soft"
                : "border-line bg-carbon-900 text-muted hover:text-ink",
            )}
            onClick={() => onShowSubagentsChange(!showSubagents)}
            title="Mostrar sesiones de subagentes"
          >
            Subagentes
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {error ? (
          <div className="mx-1.5 mb-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-[10px] leading-4 text-danger">
            No se pudieron cargar las sesiones.
            {onRetry ? (
              <button className="ml-1 underline underline-offset-2 hover:text-ink" onClick={onRetry}>
                Reintentar
              </button>
            ) : null}
          </div>
        ) : null}
        {loading && sessions.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted">
            <Loader2 size={13} className="animate-spin" /> Cargando sesiones…
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs font-medium text-ink">Sin conversaciones</p>
            <p className="mt-1 text-[11px] leading-5 text-faint">
              Ajusta los filtros o crea un chat nuevo para empezar.
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-2">
              <div className="sticky top-0 z-10 bg-carbon-900/95 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-faint backdrop-blur">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((session) => {
                  const running = runningIds.has(session.id);
                  const attention = attentionIds?.has(session.id) ?? false;
                  const active = session.id === selectedId;
                  return (
                    <div
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      aria-busy={running || attention}
                      onClick={() => onSelect(session.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelect(session.id);
                        }
                      }}
                      className={cn(
                        "group flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-violet/60",
                        active
                          ? "bg-carbon-800 text-ink"
                          : "text-muted hover:bg-carbon-850 hover:text-ink",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1.5 size-1.5 shrink-0 rounded-full",
                          attention
                            ? "animate-pulse bg-warning"
                            : running
                              ? "animate-pulse bg-violet"
                              : session.outcome === "failed"
                                ? "bg-danger/70"
                                : session.outcome === "interrupted"
                                  ? "bg-warning/70"
                                  : "bg-line",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        {running ? <span className="sr-only">Trabajando</span> : null}
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12.5px] font-medium leading-5">
                            {session.title ?? session.id}
                          </span>
                          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-faint">
                            {attention ? (
                              <span title="Espera tu intervención" aria-label="Necesita atención">
                                <ShieldAlert size={11} className="text-warning" />
                              </span>
                            ) : null}
                            {running ? (
                              <Loader2 size={11} className="animate-spin text-violet-soft" />
                            ) : (
                              <span className="group-hover:hidden">{listTime(session.time.updated)}</span>
                            )}
                            <button
                              type="button"
                              className="hidden rounded p-0.5 text-faint transition-colors hover:text-danger group-hover:block"
                              onClick={(event) => {
                                event.stopPropagation();
                                onDelete(session);
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                              title="Eliminar chat"
                              aria-label={`Eliminar ${session.title ?? session.id}`}
                            >
                              <Trash2 size={12} />
                            </button>
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-faint">
                          {session.parentID ? (
                            <span className="rounded border border-line px-1 py-px text-[8px] uppercase tracking-wide">
                              sub
                            </span>
                          ) : (
                            <Bot size={10} className="shrink-0" />
                          )}
                          <span className="truncate">{session.agent ?? "agente"}</span>
                          <span className="text-line">·</span>
                          <span className="truncate font-mono">{modelShort(session)}</span>
                          <OutcomeIcon outcome={session.outcome} />
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2 text-[10px] text-faint">
        <span className={cn("size-1.5 rounded-full", dotClass)} />
        <span>{liveLabel}</span>
        <span className="ml-auto truncate font-mono" title={projectLabel}>
          {shortPath(projectLabel)}
        </span>
      </div>
    </div>
  );
}
