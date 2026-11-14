import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Bot,
  CircleStop,
  Cpu,
  MessagesSquare,
  Send,
  User,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "../components/ProjectContext";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Section,
  Spinner,
} from "../components/ui";
import { api } from "../lib/api";
import { cn, formatCompact, formatDate, formatUsd, modelLabel, relativeTime, shortPath, statusClass } from "../lib/format";
import { rpc } from "../lib/rpc";
import type { CatalogModel, Session, SessionMessage } from "../lib/types";

export function SessionsPage() {
  const { projectId, project } = useProject();
  const directory = project?.canonical;
  const [onlyProject, setOnlyProject] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const queryClient = useQueryClient();

  const sessions = useQuery({ queryKey: ["opencode", "sessions"], queryFn: () => api.sessions(80) });
  const agents = useQuery({ queryKey: ["opencode", "agents", directory ?? "default"], queryFn: () => api.agents(directory) });
  const models = useQuery({
    queryKey: ["factory", "models", directory ?? "default"],
    queryFn: () => rpc<{ count: number; models: CatalogModel[] }>("models.list", { limit: 2000 }, directory),
  });
  const context = useQuery({
    queryKey: ["opencode", "session-context", selectedId],
    queryFn: () => api.sessionContext(selectedId!),
    enabled: Boolean(selectedId),
  });

  const filtered = useMemo(() => {
    const list = sessions.data ?? [];
    return (onlyProject ? list.filter((session) => session.projectID === projectId) : list).sort(
      (left, right) => right.time.updated - left.time.updated,
    );
  }, [sessions.data, onlyProject, projectId]);

  const selected = filtered.find((session) => session.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    setAgent(selected.agent);
    setModel(selected.model ? `${selected.model.providerID}/${selected.model.id}` : "");
  }, [selected?.id]);

  const refreshSession = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["opencode", "sessions"] }),
      queryClient.invalidateQueries({ queryKey: ["opencode", "session-context", selectedId] }),
    ]);
  };

  const switchAgent = useMutation({
    mutationFn: (nextAgent: string) => api.switchAgent(selectedId!, nextAgent),
    onSuccess: refreshSession,
  });

  const switchModel = useMutation({
    mutationFn: (ref: string) => {
      const slash = ref.indexOf("/");
      return api.switchModel(selectedId!, {
        providerID: ref.slice(0, slash),
        id: ref.slice(slash + 1),
      });
    },
    onSuccess: refreshSession,
  });

  const send = useMutation({
    mutationFn: () => api.prompt(selectedId!, prompt.trim()),
    onSuccess: async () => {
      setPrompt("");
      await refreshSession();
    },
  });

  const interrupt = useMutation({
    mutationFn: () => api.interrupt(selectedId!),
    onSuccess: refreshSession,
  });

  const modelsByProvider = useMemo(() => {
    const groups = new Map<string, CatalogModel[]>();
    for (const item of models.data?.models ?? []) {
      if (!item.enabled || !item.authorized || item.prohibited) continue;
      const list = groups.get(item.providerId) ?? [];
      list.push(item);
      groups.set(item.providerId, list);
    }
    for (const list of groups.values()) {
      list.sort((left, right) => (left.name ?? left.modelId).localeCompare(right.name ?? right.modelId));
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [models.data]);

  const error = sessions.error ?? agents.error ?? models.error ?? context.error;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sessions"
        subtitle="Conversaciones y ejecuciones de OpenCode. Puedes abrir una sesión, cambiar agente o modelo, enviar un prompt e interrumpir."
        actions={
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              className="size-3.5 accent-[#7c5cff]"
              checked={onlyProject}
              onChange={(event) => setOnlyProject(event.target.checked)}
            />
            Solo {project ? shortPath(project.canonical) : "proyecto actual"}
          </label>
        }
      />

      {error ? <ErrorState error={error} onRetry={() => void sessions.refetch()} /> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <Section
          className="min-w-0"
          title="Recientes"
          description={`${filtered.length} sesiones · actualizado ${relativeTime(new Date().toISOString())}`}
        >
          {sessions.isLoading ? (
            <div className="p-6">
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<MessagesSquare size={26} />}
              title="Sin sesiones"
              description="No hay sesiones para el filtro actual."
            />
          ) : (
            <div className="max-h-[680px] overflow-auto">
              <table className="w-full border-collapse text-left">
                <thead className="sticky top-0 z-10 bg-carbon-850">
                  <tr>
                    <th className="table-head px-4 py-2.5">Sesión</th>
                    <th className="table-head px-4 py-2.5">Agente</th>
                    <th className="table-head px-4 py-2.5">Modelo</th>
                    <th className="table-head px-4 py-2.5">Coste</th>
                    <th className="table-head px-4 py-2.5">Actualizada</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((session) => (
                    <tr
                      key={session.id}
                      className={cn(
                        "table-row cursor-pointer",
                        selectedId === session.id ? "bg-violet/10" : undefined,
                      )}
                      onClick={() => setSelectedId(session.id)}
                    >
                      <td className="max-w-[360px] px-4 py-3">
                        <div className="truncate text-xs font-medium text-ink">
                          {session.title ?? session.id}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-faint">
                          <span className="font-mono">{session.id.slice(0, 12)}…</span>
                          <span>{shortPath(session.location?.directory)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 text-[11px] text-muted">
                          <Bot size={12} />
                          {session.agent}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[10px] text-muted">
                        {modelLabel(session.model?.providerID, session.model?.id)}
                      </td>
                      <td className="px-4 py-3 text-[11px] text-muted">{formatUsd(session.cost)}</td>
                      <td className="px-4 py-3 text-[11px] text-muted">
                        <div>{relativeTime(session.time.updated)}</div>
                        <div className="text-[10px] text-faint">
                          {formatCompact(session.tokens.input + session.tokens.output)} tok
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Card className="flex min-h-[520px] min-w-0 flex-col overflow-hidden xl:max-h-[calc(100vh-180px)]">
          {!selected ? (
            <EmptyState
              icon={<MessagesSquare size={26} />}
              title="Selecciona una sesión"
              description="Abre una conversación para ver mensajes y controlar el agente, el modelo y el prompt."
            />
          ) : (
            <>
              <div className="border-b border-line-soft px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="line-clamp-2 break-words text-sm font-semibold text-ink">{selected.title ?? selected.id}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-faint">
                      <span className="font-mono">{selected.id}</span>
                      {selected.outcome ? (
                        <span className={cn("badge", statusClass(selected.outcome))}>{selected.outcome}</span>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    variant="danger"
                    onClick={() => interrupt.mutate()}
                    disabled={interrupt.isPending}
                    title="Interrumpir la ejecución"
                  >
                    <CircleStop size={14} /> Interrumpir
                  </Button>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="text-[10px] text-faint">
                    Agente
                    <select
                      className="field mt-1 h-8 text-xs"
                      value={agent}
                      onChange={(event) => {
                        setAgent(event.target.value);
                        switchAgent.mutate(event.target.value);
                      }}
                    >
                      {(agents.data ?? []).map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.id} ({item.mode})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[10px] text-faint">
                    Modelo
                    <select
                      className="field mt-1 h-8 text-xs"
                      value={model}
                      onChange={(event) => {
                        setModel(event.target.value);
                        switchModel.mutate(event.target.value);
                      }}
                    >
                      {modelsByProvider.map(([provider, list]) => (
                        <optgroup key={provider} label={provider}>
                          {list.map((item) => (
                            <option key={`${provider}/${item.modelId}`} value={`${provider}/${item.modelId}`}>
                              {item.name ?? item.modelId}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {context.isLoading ? (
                  <Spinner label="Cargando mensajes" />
                ) : context.isError ? (
                  <ErrorState error={context.error} onRetry={() => void context.refetch()} />
                ) : (context.data?.length ?? 0) === 0 ? (
                  <EmptyState title="Sin mensajes" description="Envía el primer prompt a esta sesión." />
                ) : (
                  <MessageList messages={context.data ?? []} />
                )}
              </div>

              <div className="border-t border-line-soft px-4 py-3">
                <div className="flex items-end gap-2">
                  <textarea
                    className="field min-h-[38px] resize-y py-2 text-xs"
                    rows={2}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Escribe un prompt para esta sesión..."
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        if (prompt.trim() && !send.isPending) send.mutate();
                      }
                    }}
                  />
                  <Button
                    variant="primary"
                    onClick={() => send.mutate()}
                    disabled={!prompt.trim() || send.isPending}
                    title="Enviar (Ctrl/Cmd+Enter)"
                  >
                    <Send size={14} /> Enviar
                  </Button>
                </div>
                {send.isError ? (
                  <div className="mt-2 text-[11px] text-danger">
                    {send.error instanceof Error ? send.error.message : String(send.error)}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function MessageList({ messages }: { messages: SessionMessage[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="space-y-4">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: SessionMessage }) {
  if (message.type === "user") {
    return (
      <div className="flex gap-2.5">
        <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-line bg-carbon-800 text-faint">
          <User size={12} />
        </div>
        <div className="min-w-0 flex-1 rounded-lg border border-line-soft bg-carbon-850 px-3 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">Tú</div>
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs leading-5 text-ink">{message.text}</div>
        </div>
      </div>
    );
  }

  if (message.type === "assistant") {
    const parts = message.content ?? [];
    return (
      <div className="flex gap-2.5">
        <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-violet/30 bg-violet/10 text-violet-soft">
          <Bot size={12} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[10px] text-faint">
            <span className="font-medium uppercase tracking-[0.08em] text-muted">
              {message.agent ?? "assistant"}
            </span>
            {message.model ? (
              <span className="font-mono">
                {message.model.providerID}/{message.model.id}
              </span>
            ) : null}
            <span className="ml-auto">{formatDate(message.time?.created)}</span>
          </div>
          <div className="space-y-2">
            {parts.map((part, index) => {
              if (part.type === "text" && part.text) {
                return (
                  <div key={index} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs leading-5 text-ink">
                    {part.text}
                  </div>
                );
              }
              if (part.type === "reasoning" && part.text) {
                return (
                  <details key={index} className="rounded-md border border-line-soft bg-carbon-900 px-2.5 py-2">
                    <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
                      Razonamiento
                    </summary>
                    <div className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[11px] leading-5 text-muted">{part.text}</div>
                  </details>
                );
              }
              if (part.type === "tool") {
                return (
                  <div
                    key={index}
                    className="flex items-center gap-2 rounded-md border border-line-soft bg-carbon-900 px-2.5 py-1.5 font-mono text-[10px] text-muted"
                  >
                    <Cpu size={11} className="text-faint" />
                    <span className="min-w-0 truncate text-ink">{part.tool ?? part.name ?? "tool"}</span>
                    <span className="ml-auto text-faint">{part.state?.status ?? "—"}</span>
                  </div>
                );
              }
              return null;
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-line-soft bg-carbon-900 px-2.5 py-1.5 font-mono text-[10px] text-muted">
      <ArrowUpRight size={11} className="text-faint" />
      <span>{message.type}</span>
      {message.text ? <span className="truncate text-faint">{message.text}</span> : null}
    </div>
  );
}
