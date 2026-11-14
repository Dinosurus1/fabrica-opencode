import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CircleStop,
  Cpu,
  MessageSquarePlus,
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
  Field,
  Modal,
  PageHeader,
  Section,
  Spinner,
} from "../components/ui";
import { api } from "../lib/api";
import { cn, formatCompact, formatDate, formatUsd, modelLabel, relativeTime, shortPath, statusClass } from "../lib/format";
import { rpc } from "../lib/rpc";
import type { CatalogModel, Session, SessionMessage } from "../lib/types";

interface NewChatDraft {
  title: string;
  agent: string;
  model: string;
  prompt: string;
}

function sessionTotalTokens(session: Session): number {
  return (session.tokens.input ?? 0) + (session.tokens.output ?? 0) + (session.tokens.reasoning ?? 0);
}

function isTemporaryDirectory(directory?: string): boolean {
  return Boolean(directory && (directory.startsWith("/tmp/") || directory.includes("/worktrees/")));
}

function messageText(message: SessionMessage): string {
  const parts = (message.content ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!.trim())
    .filter(Boolean);
  return (parts.join("\n") || message.text || "").trim();
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function lastContextTokens(messages: SessionMessage[]): number {
  const assistant = [...messages].reverse().find((message) => message.type === "assistant" && message.tokens);
  if (!assistant?.tokens) return 0;
  return (
    (assistant.tokens.input ?? 0) +
    (assistant.tokens.cache?.read ?? 0) +
    (assistant.tokens.cache?.write ?? 0)
  );
}

function buildHandoffPrompt(session: Session, messages: SessionMessage[]): string {
  const userMessages = messages
    .filter((message) => message.type === "user")
    .map((message) => truncate(messageText(message), 500))
    .filter(Boolean)
    .slice(-8);
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.type === "assistant" && messageText(message));
  const lines = [
    `Continuación de la sesión «${session.title ?? session.id}» (${session.id}).`,
    `Proyecto: ${session.location?.directory ?? "—"}.`,
    userMessages.length > 0
      ? `Pedidos recientes:\n${userMessages.map((text) => `- ${text}`).join("\n")}`
      : "",
    lastAssistant
      ? `Último estado reportado por el asistente:\n${truncate(messageText(lastAssistant), 1800)}`
      : "",
    "Continúa desde este punto. Antes de actuar, revisa el estado actual del repositorio y la memoria del proyecto; no repitas trabajo ya hecho. Si falta contexto, pide solo lo mínimo necesario y evita arrastrar el historial completo.",
  ];
  return lines.filter(Boolean).join("\n\n");
}

export function SessionsPage() {
  const { projects, projectId, project } = useProject();
  const directory = project?.canonical;
  const [onlyProject, setOnlyProject] = useState(false);
  const [showSubagents, setShowSubagents] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [newChat, setNewChat] = useState<NewChatDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const sessions = useQuery({ queryKey: ["opencode", "sessions"], queryFn: () => api.sessions(500) });
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
    return list
      .filter((session) => !isTemporaryDirectory(session.location?.directory))
      .filter((session) => {
        if (onlyProject && session.projectID !== projectId) return false;
        if (session.parentID) return showSubagents;
        return Boolean(session.agent) && Boolean(session.title?.trim());
      })
      .sort((left, right) => right.time.updated - left.time.updated);
  }, [sessions.data, onlyProject, projectId, showSubagents]);

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

  const createChat = useMutation({
    mutationFn: async (draft: NewChatDraft) => {
      const slash = draft.model.indexOf("/");
      const created = await api.createSession({
        title: draft.title.trim() || truncate(draft.prompt.trim(), 60) || "Nueva sesión",
        agent: draft.agent || undefined,
        model:
          slash > 0
            ? { providerID: draft.model.slice(0, slash), id: draft.model.slice(slash + 1) }
            : undefined,
        directory,
      });
      let promptError: string | null = null;
      if (draft.prompt.trim()) {
        try {
          await api.prompt(created.id, draft.prompt.trim());
        } catch (error) {
          promptError = error instanceof Error ? error.message : String(error);
        }
      }
      return { created, promptError };
    },
    onSuccess: async ({ created, promptError }) => {
      setNewChat(null);
      setSelectedId(created.id);
      setNotice(promptError ? `Sesión creada, pero el primer prompt falló: ${promptError}` : null);
      queryClient.setQueryData(["opencode", "sessions"], (current: Session[] | undefined) => [
        created,
        ...(current ?? []).filter((session) => session.id !== created.id),
      ]);
      await queryClient.invalidateQueries({ queryKey: ["opencode", "sessions"] });
    },
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

  const chatAgents = useMemo(
    () => (agents.data ?? []).filter((item) => item.mode !== "subagent"),
    [agents.data],
  );

  const contextTokens = useMemo(() => lastContextTokens(context.data ?? []), [context.data]);
  const contextLimit = useMemo(
    () =>
      (models.data?.models ?? []).find(
        (item) => item.providerId === selected?.model?.providerID && item.modelId === selected?.model?.id,
      )?.contextLimit ?? null,
    [models.data, selected?.model?.id, selected?.model?.providerID],
  );
  const longSession = Boolean(
    selected &&
      (sessionTotalTokens(selected) >= 2_000_000 ||
        (contextLimit !== null && contextLimit > 0 && contextTokens >= contextLimit * 0.6)),
  );

  const defaultChatAgent = (session: Session | null) =>
    chatAgents.find((item) => item.id === session?.agent)?.id ?? chatAgents[0]?.id ?? "factory";

  const openNewChat = () => {
    setNotice(null);
    setNewChat({
      title: "",
      agent: defaultChatAgent(selected),
      model: selected?.model ? `${selected.model.providerID}/${selected.model.id}` : "",
      prompt: "",
    });
  };

  const openContinuation = () => {
    if (!selected) return;
    setNotice(null);
    setNewChat({
      title: truncate(`Continuación · ${selected.title ?? selected.id}`, 90),
      agent: defaultChatAgent(selected),
      model: selected.model ? `${selected.model.providerID}/${selected.model.id}` : "",
      prompt: buildHandoffPrompt(selected, context.data ?? []),
    });
  };

  const error = sessions.error ?? agents.error ?? models.error ?? context.error;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sessions"
        subtitle="Conversaciones y ejecuciones de OpenCode. Crea chats nuevos, abre una sesión, cambia agente o modelo, envía un prompt e interrumpe."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" className="h-8 px-3 text-xs" onClick={openNewChat}>
              <MessageSquarePlus size={13} /> Nuevo chat
            </Button>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="size-3.5 accent-[#7c5cff]"
                checked={onlyProject}
                onChange={(event) => setOnlyProject(event.target.checked)}
              />
              Solo {project ? shortPath(project.canonical) : "proyecto actual"}
            </label>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="size-3.5 accent-[#7c5cff]"
                checked={showSubagents}
                onChange={(event) => setShowSubagents(event.target.checked)}
              />
              Subagentes
            </label>
          </div>
        }
      />

      {notice ? (
        <div className="rounded-lg border border-violet/30 bg-violet/10 px-3 py-2 text-xs text-violet-soft">{notice}</div>
      ) : null}

      {error ? <ErrorState error={error} onRetry={() => void sessions.refetch()} /> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(380px,0.8fr)]">
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
                      <td className="max-w-[240px] px-4 py-3">
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
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-faint">
                          <span>{formatCompact(sessionTotalTokens(session))} tok</span>
                          {sessionTotalTokens(session) >= 2_000_000 ? <Badge tone="warning">larga</Badge> : null}
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

              {longSession ? (
                <div className="border-b border-warning/30 bg-warning/10 px-4 py-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-warning">Sesión muy larga</p>
                      <p className="mt-0.5 text-[11px] leading-5 text-muted">
                        {formatCompact(sessionTotalTokens(selected))} tokens acumulados
                        {contextLimit && contextTokens > 0
                          ? ` · contexto ${formatCompact(contextTokens)} / ${formatCompact(contextLimit)}`
                          : ""}. Para seguir sin arrastrar todo el historial, crea una continuación con un resumen
                        editable de los últimos cambios.
                      </p>
                    </div>
                    <Button
                      variant="default"
                      className="h-7 shrink-0 px-2 text-[11px]"
                      onClick={openContinuation}
                      disabled={context.isLoading}
                    >
                      <MessageSquarePlus size={12} /> Continuar en nueva sesión
                    </Button>
                  </div>
                </div>
              ) : null}

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

      <Modal
        open={Boolean(newChat)}
        title="Nuevo chat"
        description="Crea una sesión limpia para no arrastrar el historial. Si vienes de una sesión larga, el resumen de traspaso es editable."
        onClose={() => setNewChat(null)}
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewChat(null)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              onClick={() => newChat && createChat.mutate(newChat)}
              disabled={!newChat || createChat.isPending || !newChat.agent}
            >
              {createChat.isPending ? "Creando..." : "Crear chat"}
            </Button>
          </>
        }
      >
        {newChat ? (
          <div className="space-y-3">
            <Field label="Título">
              <input
                className="field"
                value={newChat.title}
                onChange={(event) => setNewChat({ ...newChat, title: event.target.value })}
                placeholder="Nueva sesión"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Agente">
                <select
                  className="field"
                  value={newChat.agent}
                  onChange={(event) => setNewChat({ ...newChat, agent: event.target.value })}
                >
                  {chatAgents.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Modelo" hint="Si lo dejas vacío, se usa el del agente.">
                <select
                  className="field"
                  value={newChat.model}
                  onChange={(event) => setNewChat({ ...newChat, model: event.target.value })}
                >
                  <option value="">Modelo del agente</option>
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
              </Field>
            </div>
            <Field
              label="Primer prompt"
              hint="Opcional. En una continuación, revisa el resumen antes de enviarlo."
            >
              <textarea
                className="field min-h-32 resize-y text-xs leading-5"
                value={newChat.prompt}
                onChange={(event) => setNewChat({ ...newChat, prompt: event.target.value })}
                placeholder="Escribe el primer mensaje o deja que la sesión espere..."
              />
            </Field>
            <p className="text-[10px] text-faint">
              Proyecto: <span className="font-mono">{directory ?? "location por defecto"}</span>
            </p>
            {createChat.isError ? (
              <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                {createChat.error instanceof Error ? createChat.error.message : String(createChat.error)}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
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
