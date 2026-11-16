import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CircleStop,
  GitBranch,
  MessageSquarePlus,
  MessagesSquare,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { PendingAttachment } from "../components/sessions/attachments";
import {
  AttachmentButton,
  AttachmentChips,
  filesFromClipboard,
  useFileAttachments,
} from "../components/sessions/attachments";
import { SessionList } from "../components/sessions/SessionList";
import { CommandMenu } from "../components/sessions/CommandMenu";
import { FormsPanel, type FormReplyState } from "../components/sessions/Forms";
import { PermissionsPanel } from "../components/sessions/Permissions";
import { messageText, Transcript } from "../components/sessions/Transcript";
import { useProject } from "../components/ProjectContext";
import { Button, ConfirmDialog, Field, Modal } from "../components/ui";
import { api, type SessionPage } from "../lib/api";
import { deleteAttachments, pruneAttachments, readAttachments, writeAttachments } from "../lib/attachmentStore";
import { findCommand, helpText, parseSlash, suggestCommands } from "../lib/commands";
import { useSessionEvents, runningSessionIds } from "../lib/events";
import { cn, formatCompact, formatUsd, relativeTime, shortPath } from "../lib/format";
import {
  applyPinnedSections,
  buildHandoff,
  estimateTokens,
  formatRepoStatus,
  HANDOFF_SECTION_LABELS,
  readCheckpoint,
  saveCheckpoint,
  type Handoff,
  type HandoffSection,
} from "../lib/handoff";
import {
  baseTitle,
  childrenOf,
  ensureRoot,
  generationForChild,
  lineageChain,
  registerChild,
  titleForHandoff,
} from "../lib/lineage";
import {
  applyPermissionEvent,
  replaceSessionPermissions,
  seedPermissions,
  sessionIdFromEvent,
} from "../lib/permissions";
import { analyzePrompt, combinePromptAndProject } from "../lib/profile-detect";
import { rpc } from "../lib/rpc";
import {
  applyStreamEvent,
  clearSessionStreams,
  clearSettledStreams,
  mergeStreamMessages,
  type StreamState,
} from "../lib/streaming";
import type {
  CatalogModel,
  FormAnswer,
  FormRequest,
  PermissionDecision,
  PermissionRequest,
  Profile,
  ProfileRecommendation,
  PromptFileAttachment,
  Session,
  SessionMessage,
} from "../lib/types";

interface HandoffMeta {
  tokens: number;
  dropped: string[];
  pinned: HandoffSection[];
}

interface NewChatDraft {
  mode: "new" | "continuation";
  title: string;
  agent: string;
  model: string;
  profileId: string;
  prompt: string;
  objective: string;
  parentId: string | null;
  parentTitle: string;
  generation: number;
  titleTouched: boolean;
  profileTouched: boolean;
  handoff: HandoffMeta | null;
}

interface CommandPanelState {
  title: string;
  body: string;
}

interface CommandPickerState {
  title: string;
  options: Array<{ label: string; value: string }>;
  onPick: (value: string) => void;
}

interface NewChatRequest extends NewChatDraft {
  files: PendingAttachment[];
}

interface OptimisticMessage {
  sessionId: string;
  text: string;
  createdAt: number;
  files: PromptFileAttachment[];
}

const SELECTED_SESSION_KEY = "factory.sessions.selected";
const ONLY_PROJECT_KEY = "factory.sessions.onlyProject";
const SUBAGENTS_KEY = "factory.sessions.subagents";
const DRAFT_PREFIX = "factory.sessions.draft.";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeValue(key: string, value: string | null) {
  try {
    if (value === null || value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // localStorage puede no estar disponible (modo privado); el estado sigue en memoria.
  }
}

function readDraft(sessionId: string): string {
  return readStored(`${DRAFT_PREFIX}${sessionId}`) ?? "";
}

function writeDraft(sessionId: string, value: string) {
  storeValue(`${DRAFT_PREFIX}${sessionId}`, value.trim() ? value : null);
}

function toPromptFiles(files: PendingAttachment[]): PromptFileAttachment[] {
  return files.map((file) => {
    const [, data = ""] = file.dataUrl.split(",");
    return { data, mime: file.mime, name: file.name, source: { type: "inline" as const } };
  });
}

function toPromptInputFiles(files: PendingAttachment[]) {
  return files.map((file) => ({ uri: file.dataUrl, name: file.name }));
}

const STREAM_EVENTS = new Set([
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.retry.scheduled",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
]);

const TERMINAL_EVENTS = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

function sessionTotalTokens(session: Session): number {
  return (session.tokens.input ?? 0) + (session.tokens.output ?? 0) + (session.tokens.reasoning ?? 0);
}

function isTemporaryDirectory(directory?: string): boolean {
  return Boolean(directory && (directory.startsWith("/tmp/") || directory.includes("/worktrees/")));
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
    .map((message) => truncate(messageText(message), 600))
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
      ? `Último estado reportado por el asistente:\n${truncate(messageText(lastAssistant), 2000)}`
      : "",
    "Continúa desde este punto. Antes de actuar, revisa el estado actual del repositorio y la memoria del proyecto; no repitas trabajo ya hecho. Si falta contexto, pide solo lo mínimo necesario y evita arrastrar el historial completo.",
  ];
  return lines.filter(Boolean).join("\n\n");
}

export function SessionsPage() {
  const { projectId, project, projects, setProjectId } = useProject();
  const directory = project?.canonical;
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedId, setSelectedId] = useState<string | null>(() => readStored(SELECTED_SESSION_KEY));
  const [query, setQuery] = useState("");
  const [onlyProject, setOnlyProject] = useState(() => readFlag(ONLY_PROJECT_KEY));
  const [showSubagents, setShowSubagents] = useState(() => readFlag(SUBAGENTS_KEY));
  const [listOpen, setListOpen] = useState(() => !readStored(SELECTED_SESSION_KEY));
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [profileId, setProfileId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [newChat, setNewChat] = useState<NewChatDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSessions, setPendingSessions] = useState<Set<string>>(() => new Set());
  const [permissionEvents, setPermissionEvents] = useState<Record<string, string[]>>({});
  const [streamState, setStreamState] = useState<StreamState>({});
  const [optimistic, setOptimistic] = useState<OptimisticMessage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [dragging, setDragging] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [commandPanel, setCommandPanel] = useState<CommandPanelState | null>(null);
  const [commandPicker, setCommandPicker] = useState<CommandPickerState | null>(null);
  const [detectPrompt, setDetectPrompt] = useState("");
  const [promptExpanded, setPromptExpanded] = useState(false);
  const attachments = useFileAttachments((files) => {
    const sessionId = selectedRef.current;
    if (sessionId) void writeAttachments(sessionId, files);
  });
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments.files;
  const attachmentDrafts = useRef(new Map<string, PendingAttachment[]>());
  const previousSessionRef = useRef<string | null>(null);
  const draftAttachments = useFileAttachments();
  const didInit = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedRef = useRef<string | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const listTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const contextTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  selectedRef.current = selectedId;

  const sessions = useQuery({
    queryKey: ["opencode", "sessions"],
    queryFn: () => api.sessionPage({ limit: 80 }),
    refetchInterval: 25_000,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
  const [extraSessions, setExtraSessions] = useState<Session[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const sessionList = useMemo(() => sessions.data?.data ?? [], [sessions.data]);
  const allSessions = useMemo(() => {
    const map = new Map<string, Session>();
    // La primera página manda sobre las extras para no mostrar datos viejos.
    for (const session of [...extraSessions, ...sessionList]) map.set(session.id, session);
    return [...map.values()];
  }, [sessionList, extraSessions]);

  useEffect(() => {
    setNextCursor(sessions.data?.cursor?.next ?? null);
  }, [sessions.data]);

  const loadMoreSessions = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.sessionPage({ limit: 80, cursor: nextCursor });
      setExtraSessions((current) => [...current, ...page.data]);
      setNextCursor(page.cursor?.next ?? null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingMore(false);
    }
  };
  const active = useQuery({
    queryKey: ["opencode", "active-sessions"],
    queryFn: api.activeSessions,
    refetchInterval: 4_000,
    refetchOnWindowFocus: true,
    staleTime: 1_000,
  });
  const agents = useQuery({
    queryKey: ["opencode", "agents", directory ?? "default"],
    queryFn: () => api.agents(directory),
  });
  const models = useQuery({
    queryKey: ["factory", "models", directory ?? "default"],
    queryFn: () => rpc<{ count: number; models: CatalogModel[] }>("models.list", { limit: 2000 }, directory),
  });
  const profiles = useQuery({
    queryKey: ["factory", "profiles", directory ?? "default"],
    queryFn: () =>
      rpc<{ count: number; profiles: Profile[]; applied_profile_id?: string | null }>(
        "profiles.list",
        {},
        directory,
      ),
  });

  // Recomendación del proyecto: se usa para preseleccionar el perfil en el
  // diálogo de nueva sesión/continuación, sin aplicarlo por sorpresa.
  const profileSuggestion = useQuery({
    queryKey: ["factory", "profile-recommend", directory ?? "default"],
    queryFn: () => rpc<ProfileRecommendation>("profiles.recommend", {}, directory),
    enabled: Boolean(directory),
    staleTime: 60_000,
  });

  const selected = allSessions.find((session) => session.id === selectedId) ?? null;
  const runningIds = useMemo(
    () => runningSessionIds(active.data, allSessions),
    [active.data, allSessions],
  );
  const visibleRunning = useMemo(() => {
    const next = new Set(runningIds);
    for (const id of pendingSessions) next.add(id);
    return next;
  }, [runningIds, pendingSessions]);
  const running = Boolean(selectedId && visibleRunning.has(selectedId));

  const addAttachmentsToCurrent = (files: FileList | File[]) => {
    const target = selectedRef.current;
    return attachments.add(files, { guard: () => selectedRef.current === target });
  };

  const markPending = (sessionId: string) => {    setPendingSessions((current) => {
      if (current.has(sessionId)) return current;
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
  };

  const clearPending = (sessionId: string) => {
    setPendingSessions((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  };

  const context = useQuery({
    queryKey: ["opencode", "session-context", selectedId],
    queryFn: () => api.sessionContext(selectedId!),
    enabled: Boolean(selectedId),
    refetchInterval: running ? 2_000 : false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const permissions = useQuery({
    queryKey: ["opencode", "session-permissions", selectedId],
    queryFn: () => api.sessionPermissions(selectedId!),
    enabled: Boolean(selectedId),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  // Vista por location: alimenta el aviso global del Layout y las marcas de la
  // lista para sesiones que no están abiertas.
  const projectPermissions = useQuery({
    queryKey: ["opencode", "permission-requests", directory ?? "default"],
    queryFn: () => api.permissionRequests(directory),
    enabled: Boolean(directory),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const pendingPermissions = useMemo(
    () => permissions.data ?? [],
    [permissions.data],
  );
  const waitingPermission = pendingPermissions.length > 0;

  const forms = useQuery({
    queryKey: ["opencode", "session-forms", selectedId],
    queryFn: () => api.sessionForms(selectedId!),
    enabled: Boolean(selectedId),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const projectForms = useQuery({
    queryKey: ["opencode", "form-requests", directory ?? "default"],
    queryFn: () => api.forms(directory),
    enabled: Boolean(directory),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const pendingForms = useMemo(() => forms.data ?? [], [forms.data]);
  const waitingForm = pendingForms.length > 0;
  const waitingApproval = waitingPermission || waitingForm;

  const attentionIds = useMemo(() => {
    let state = seedPermissions(permissionEvents, projectPermissions.data);
    if (selectedId) state = replaceSessionPermissions(state, selectedId, permissions.data);
    const next = new Set(Object.keys(state));
    for (const form of projectForms.data ?? []) next.add(form.sessionID);
    if (selectedId && pendingForms.length > 0) next.add(selectedId);
    return next;
  }, [permissionEvents, projectPermissions.data, permissions.data, selectedId, projectForms.data, pendingForms.length]);

  const invalidateSessions = (delay = 400) => {
    if (listTimer.current) clearTimeout(listTimer.current);
    listTimer.current = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["opencode", "sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["opencode", "active-sessions"] });
    }, delay);
  };

  const invalidateContext = (delay = 250) => {
    if (contextTimer.current) clearTimeout(contextTimer.current);
    contextTimer.current = setTimeout(() => {
      const id = selectedRef.current;
      if (id) void queryClient.invalidateQueries({ queryKey: ["opencode", "session-context", id] });
    }, delay);
  };

  const live = useSessionEvents((event) => {
    const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined;
    const streaming = STREAM_EVENTS.has(event.type);
    const textStream = /^session\.(text|reasoning)\./.test(event.type);

    if (event.type === "session.deleted" && sessionID) {
      setStreamState((current) => clearSessionStreams(current, sessionID));
    }

    // El streaming de texto se acumula en local: no hace falta pedir el
    // contexto completo en cada delta. El contexto se refresca al terminar el
    // bloque y al llegar a un estado terminal.
    if (textStream) {
      setStreamState((current) => applyStreamEvent(current, event));
      if (sessionID) {
        markPending(sessionID);
        if (event.type.endsWith(".ended") && sessionID === selectedRef.current) {
          invalidateContext(600);
        }
      }
      return;
    }

    if (event.type.startsWith("session.") && !streaming) invalidateSessions(600);

    if (event.type === "form.created" || event.type === "form.replied" || event.type === "form.cancelled") {
      const target = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined;
      if (target) {
        void queryClient.invalidateQueries({ queryKey: ["opencode", "session-forms", target] });
        if (target === selectedRef.current) invalidateContext(1_200);
      }
      void queryClient.invalidateQueries({ queryKey: ["opencode", "form-requests"] });
      return;
    }

    if (event.type === "permission.asked" || event.type === "permission.replied") {
      setPermissionEvents((current) => applyPermissionEvent(current, event));
      const target = sessionIdFromEvent(event);
      if (target) {
        void queryClient.invalidateQueries({
          queryKey: ["opencode", "session-permissions", target],
        });
        if (target === selectedRef.current) invalidateContext(1_200);
      }
      void queryClient.invalidateQueries({ queryKey: ["opencode", "permission-requests"] });
      return;
    }

    if (event.type === "session.status" && sessionID) {
      const status = (event.data?.status as { type?: string } | undefined)?.type;
      if (status === "busy" || status === "retry") {
        markPending(sessionID);
      } else if (status === "idle") {
        clearPending(sessionID);
        if (sessionID === selectedRef.current) invalidateContext(0);
      }
      return;
    }

    // El estado de "trabajando" se resuelve por sesión, aunque el evento sea
    // de otra conversación distinta a la abierta.
    if (sessionID && TERMINAL_EVENTS.has(event.type)) {
      clearPending(sessionID);
      if (sessionID === selectedRef.current) invalidateContext(0);
      return;
    }
    if (sessionID && event.type === "session.execution.started") {
      markPending(sessionID);
      if (sessionID === selectedRef.current) invalidateContext(300);
      return;
    }
    if (!sessionID || sessionID !== selectedRef.current) return;
    if (streaming) {
      markPending(sessionID);
      invalidateContext(900);
    }
  });

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return allSessions
      .filter((session) => !isTemporaryDirectory(session.location?.directory))
      .filter((session) => {
        if (onlyProject && session.projectID !== projectId) return false;
        if (session.parentID) return showSubagents;
        return Boolean(session.agent) && Boolean(session.title?.trim());
      })
      .filter((session) => {
        if (!text) return true;
        return `${session.title ?? ""} ${session.id} ${session.agent} ${session.model?.providerID ?? ""} ${session.model?.id ?? ""} ${session.location?.directory ?? ""}`
          .toLowerCase()
          .includes(text);
      })
      .sort((left, right) => right.time.updated - left.time.updated);
  }, [allSessions, onlyProject, projectId, query, showSubagents]);

  useEffect(() => {
    if (!selected) return;
    setAgent(selected.agent ?? "");
    setModel(selected.model ? `${selected.model.providerID}/${selected.model.id}` : "");
  }, [selected?.id, selected?.agent, selected?.model?.id, selected?.model?.providerID]);

  useEffect(() => {
    const applied = profiles.data?.applied_profile_id;
    if (applied) setProfileId(applied);
  }, [profiles.data?.applied_profile_id]);

  // Si el diálogo se abrió antes de que llegara la recomendación, la aplica
  // como preselección. Nunca pisa una elección explícita del usuario.
  useEffect(() => {
    const suggested = profileSuggestion.data?.profile?.id;
    if (!suggested) return;
    setNewChat((current) =>
      current && !current.profileId ? { ...current, profileId: suggested } : current,
    );
  }, [profileSuggestion.data?.profile?.id]);

  // Cada conversación conserva su borrador y sus adjuntos pendientes. El texto
  // se guarda en localStorage; los adjuntos en IndexedDB.
  useEffect(() => {
    const previous = previousSessionRef.current;
    if (previous && previous !== selectedId) {
      attachmentDrafts.current.set(previous, attachmentsRef.current);
      void writeAttachments(previous, attachmentsRef.current);
    }
    previousSessionRef.current = selectedId;
    setPrompt(selectedId ? readDraft(selectedId) : "");
    const cached = selectedId ? attachmentDrafts.current.get(selectedId) : undefined;
    attachments.replace(selectedId ? cached ?? [] : []);
    if (!selectedId || cached) return;
    // Si la pestaña se recargó, recupera los adjuntos pendientes de IndexedDB.
    let active = true;
    void readAttachments(selectedId)
      .then((files) => {
        if (!active || selectedRef.current !== selectedId || files.length === 0) return;
        attachmentDrafts.current.set(selectedId, files);
        attachments.replace(files);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  useEffect(() => {
    void pruneAttachments();
  }, []);

  useEffect(() => {
    storeValue(SELECTED_SESSION_KEY, selectedId);
  }, [selectedId]);

  // Sincronización entre pestañas: la sesión abierta y los borradores viajan
  // por localStorage. La pestaña que recibe no reescribe la clave, así que no
  // se producen bucles de eventos.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.key) return;
      if (event.key === SELECTED_SESSION_KEY) {
        if (event.newValue && event.newValue !== selectedRef.current) {
          setSelectedId(event.newValue);
          setListOpen(false);
        }
        return;
      }
      if (!event.key.startsWith(DRAFT_PREFIX)) return;
      const sessionId = event.key.slice(DRAFT_PREFIX.length);
      if (sessionId !== selectedRef.current) return;
      // No pisotear lo que el usuario está escribiendo en esta pestaña.
      if (document.activeElement === textareaRef.current) return;
      setPrompt(event.newValue ?? "");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Al volver de segundo plano o recuperar la red, resincroniza el estado que
  // el SSE pudo perder mientras la pestaña estaba suspendida.
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState !== "visible") return;
      void sessions.refetch();
      void active.refetch();
      if (selectedRef.current) void context.refetch();
      void queryClient.invalidateQueries({ queryKey: ["opencode", "permission-requests"] });
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
    };
  }, [sessions.refetch, active.refetch, context.refetch, queryClient]);

  // Cuando la ejecución termina y el contexto ya trae el mensaje final, el
  // buffer de deltas deja de ser necesario.
  useEffect(() => {
    if (!selectedId || running || !context.data) return;
    setStreamState((current) => clearSettledStreams(current, selectedId, context.data!));
  }, [selectedId, running, context.data]);

  // El aviso global enlaza a /sessions?session=<id>; se consume una sola vez.
  useEffect(() => {
    const requested = searchParams.get("session");
    if (!requested) return;
    setSelectedId(requested);
    setListOpen(false);
    const next = new URLSearchParams(searchParams);
    next.delete("session");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    storeValue(ONLY_PROJECT_KEY, onlyProject ? "1" : null);
  }, [onlyProject]);

  useEffect(() => {
    storeValue(SUBAGENTS_KEY, showSubagents ? "1" : null);
  }, [showSubagents]);

  useEffect(() => {
    if (didInit.current || !sessions.data) return;
    didInit.current = true;
    if (selectedId) return;
    const first = filtered[0]?.id ?? null;
    if (first) {
      setSelectedId(first);
      setListOpen(false);
    }
  }, [sessions.data, filtered, selectedId]);

  useEffect(() => {
    if (!selectedId || !sessions.data) return;
    if (allSessions.some((session) => session.id === selectedId)) return;
    setSelectedId(filtered[0]?.id ?? null);
  }, [allSessions, sessions.data, selectedId, filtered]);

  useEffect(() => {
    if (!optimistic || optimistic.sessionId !== selectedId) return;
    const found = (context.data ?? []).some((message) => {
      if (message.type !== "user" || messageText(message) !== optimistic.text) return false;
      if (optimistic.files.length === 0) return true;
      const names = new Set((message.files ?? []).map((file) => file.name ?? ""));
      return optimistic.files.every((file) => names.has(file.name ?? ""));
    });
    if (found) setOptimistic(null);
  }, [context.data, optimistic, selectedId]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [prompt]);

  useEffect(() => {
    if (pendingSessions.size === 0) return;
    const timer = setTimeout(() => setPendingSessions(new Set()), 120_000);
    return () => clearTimeout(timer);
  }, [pendingSessions]);

  useEffect(() => {
    if (!optimistic) return;
    const timer = setTimeout(() => setOptimistic(null), 20_000);
    return () => clearTimeout(timer);
  }, [optimistic]);

  useEffect(() => {
    return () => {
      if (listTimer.current) clearTimeout(listTimer.current);
      if (contextTimer.current) clearTimeout(contextTimer.current);
    };
  }, []);

  const switchAgent = useMutation({
    mutationFn: (nextAgent: string) => api.switchAgent(selectedId!, nextAgent),
    onSuccess: () => {
      invalidateContext(0);
      invalidateSessions(0);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const switchModel = useMutation({
    mutationFn: (ref: string) => {
      const slash = ref.indexOf("/");
      return api.switchModel(selectedId!, {
        providerID: ref.slice(0, slash),
        id: ref.slice(slash + 1),
      });
    },
    onSuccess: () => {
      invalidateContext(0);
      invalidateSessions(0);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const applyProfile = useMutation({
    mutationFn: (id: string) =>
      rpc<{ applied: boolean; warnings?: string[]; session_updated?: boolean }>(
        "profiles.apply",
        { id, confirmed: true, session_id: selectedId },
        directory,
      ),
    onSuccess: (result, id) => {
      if (!result.applied) {
        setProfileId(profiles.data?.applied_profile_id ?? "");
        setNotice("El perfil no se aplicó: revisa su validación en Models.");
        return;
      }
      const name = profiles.data?.profiles.find((item) => item.id === id)?.name ?? "perfil";
      const warnings = result.warnings?.length ? ` Avisos: ${result.warnings.join(" ")}` : "";
      setNotice(
        `Perfil «${name}» aplicado a los agentes${result.session_updated ? " y a esta sesión" : ""}.${warnings}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["factory", "profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["factory", "profile"] });
      void queryClient.invalidateQueries({ queryKey: ["factory", "agents"] });
      invalidateContext(0);
      invalidateSessions(0);
    },
    onError: (error) => {
      setProfileId(profiles.data?.applied_profile_id ?? "");
      setNotice(error instanceof Error ? error.message : String(error));
    },
  });

  const send = useMutation({
    mutationFn: ({
      sessionId,
      text,
      files,
    }: {
      sessionId: string;
      text: string;
      files: PendingAttachment[];
    }) => api.prompt(sessionId, text, toPromptInputFiles(files)),
    onMutate: ({ sessionId, text, files }) => {
      setNotice(null);
      markPending(sessionId);
      if (sessionId === selectedRef.current) {
        setOptimistic({ sessionId, text, createdAt: Date.now(), files: toPromptFiles(files) });
      }
    },
    onSuccess: (_result, { sessionId, text, files }) => {
      // No borrar lo que el usuario haya escrito o adjuntado mientras el envío
      // estaba en curso: solo se retira lo que formaba parte de este mensaje.
      if (promptRef.current === text) {
        writeDraft(sessionId, "");
        if (selectedRef.current === sessionId) setPrompt("");
      }
      const sent = new Set(files.map((file) => file.id));
      const remaining = (attachmentDrafts.current.get(sessionId) ?? []).filter(
        (file) => !sent.has(file.id),
      );
      if (remaining.length > 0) attachmentDrafts.current.set(sessionId, remaining);
      else attachmentDrafts.current.delete(sessionId);
      void writeAttachments(sessionId, remaining);
      if (selectedRef.current === sessionId) {
        for (const file of files) attachments.remove(file.id);
      }
      invalidateContext(0);
    },
    onError: (error, { sessionId }) => {
      setOptimistic((current) => (current?.sessionId === sessionId ? null : current));
      clearPending(sessionId);
      setNotice(error instanceof Error ? error.message : String(error));
    },
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: (_result, id) => {
      setDeleteTarget(null);
      queryClient.setQueryData(["opencode", "sessions"], (current: SessionPage | undefined) => ({
        ...(current ?? { data: [] }),
        data: (current?.data ?? []).filter((session) => session.id !== id),
      }));
      setExtraSessions((current) => current.filter((session) => session.id !== id));
      queryClient.removeQueries({ queryKey: ["opencode", "session-context", id] });
      setStreamState((current) => clearSessionStreams(current, id));
      writeDraft(id, "");
      attachmentDrafts.current.delete(id);
      void deleteAttachments(id);
      clearPending(id);
      setOptimistic((current) => (current?.sessionId === id ? null : current));
      if (selectedId === id) {
        previousSessionRef.current = null;
        setSelectedId(null);
        setPrompt("");
        attachments.clear();
      }
      invalidateSessions(0);
    },
    onError: (error) => {
      setDeleteTarget(null);
      setNotice(error instanceof Error ? error.message : String(error));
    },
  });

  const interrupt = useMutation({
    mutationFn: (sessionId: string) => api.interrupt(sessionId),
    onSuccess: (_result, sessionId) => {
      clearPending(sessionId);
      if (selectedRef.current === sessionId) invalidateContext(0);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const replyPermission = useMutation({
    mutationFn: ({
      request,
      decision,
      message,
    }: {
      request: PermissionRequest;
      decision: PermissionDecision;
      message?: string;
    }) => api.replyPermission(request.sessionID, request.id, decision, message),
    onSuccess: (_result, { request }) => {
      setPermissionEvents((current) =>
        applyPermissionEvent(current, {
          type: "permission.replied",
          data: { sessionID: request.sessionID, requestID: request.id },
        }),
      );
      void queryClient.invalidateQueries({
        queryKey: ["opencode", "session-permissions", request.sessionID],
      });
      void queryClient.invalidateQueries({ queryKey: ["opencode", "permission-requests"] });
      invalidateContext(200);
      invalidateSessions(0);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const replyForm = useMutation({
    mutationFn: ({ form, answer }: { form: FormRequest; answer: FormAnswer }) =>
      api.replyForm(form.sessionID, form.id, answer),
    onSuccess: (_result, { form }) => {
      void queryClient.invalidateQueries({
        queryKey: ["opencode", "session-forms", form.sessionID],
      });
      void queryClient.invalidateQueries({ queryKey: ["opencode", "form-requests"] });
      invalidateContext(200);
      invalidateSessions(0);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const cancelForm = useMutation({
    mutationFn: (form: FormRequest) => api.cancelForm(form.sessionID, form.id),
    onSuccess: (_result, form) => {
      void queryClient.invalidateQueries({
        queryKey: ["opencode", "session-forms", form.sessionID],
      });
      void queryClient.invalidateQueries({ queryKey: ["opencode", "form-requests"] });
      invalidateContext(200);
      invalidateSessions(0);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const refresh = () => {
    setExtraSessions([]);
    void sessions.refetch();
    void active.refetch();
    if (selectedId) {
      void queryClient.invalidateQueries({ queryKey: ["opencode", "session-context", selectedId] });
      void queryClient.invalidateQueries({ queryKey: ["opencode", "session-permissions", selectedId] });
      void queryClient.invalidateQueries({ queryKey: ["opencode", "session-forms", selectedId] });
    }
    void queryClient.invalidateQueries({ queryKey: ["opencode", "permission-requests"] });
    void queryClient.invalidateQueries({ queryKey: ["opencode", "form-requests"] });
  };

  const createChat = useMutation({
    mutationFn: async (draft: NewChatRequest) => {
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
      let profileWarning: string | null = null;
      if (draft.profileId) {
        try {
          const applied = await rpc<{ applied: boolean; warnings?: string[]; session_updated?: boolean }>(
            "profiles.apply",
            { id: draft.profileId, confirmed: true, session_id: created.id },
            directory,
          );
          if (!applied.applied) {
            profileWarning = "El perfil no se aplicó: revisa su validación en Models.";
          } else if (applied.warnings?.length) {
            profileWarning = `Perfil aplicado con avisos: ${applied.warnings.join(" ")}`;
          }
        } catch (error) {
          profileWarning = `La sesión se creó, pero el perfil falló: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
      let promptError: string | null = null;
      if (draft.prompt.trim() || draft.files.length > 0) {
        try {
          await api.prompt(created.id, draft.prompt.trim(), toPromptInputFiles(draft.files));
        } catch (error) {
          promptError = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        created,
        promptError,
        profileWarning,
        prompted: Boolean(draft.prompt.trim() || draft.files.length),
      };
    },
    onSuccess: async ({ created, promptError, profileWarning, prompted }, draft) => {
      if (draft.mode === "continuation" && draft.parentId) {
        registerChild(
          draft.parentId,
          draft.parentTitle,
          created.id,
          draft.objective || created.title || "Sesión",
          draft.title,
        );
      }
      setNewChat(null);
      draftAttachments.clear();
      setSelectedId(created.id);
      setListOpen(false);
      if (prompted && !promptError) markPending(created.id);
      const warnings = [profileWarning, promptError ? `el primer prompt falló: ${promptError}` : null].filter(
        Boolean,
      );
      setNotice(warnings.length ? `Sesión creada. ${warnings.join(" · ")}` : null);
      queryClient.setQueryData(["opencode", "sessions"], (current: SessionPage | undefined) => ({
        ...(current ?? { data: [] }),
        data: [
          created,
          ...(current?.data ?? []).filter((session) => session.id !== created.id),
        ],
      }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["opencode", "sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "profiles"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "profile"] }),
      ]);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
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
  const contextRatio =
    contextLimit && contextTokens > 0 ? Math.min(100, Math.round((contextTokens / contextLimit) * 100)) : 0;
  const longSession = Boolean(
    selected &&
      (sessionTotalTokens(selected) >= 2_000_000 || (contextLimit !== null && contextLimit > 0 && contextTokens >= contextLimit * 0.6)),
  );

  const transcript = useMemo(() => {
    let messages = context.data ?? [];
    if (optimistic && optimistic.sessionId === selectedId) {
      const alreadyThere = messages.some(
        (message) => message.type === "user" && messageText(message) === optimistic.text,
      );
      if (!alreadyThere) {
        const pending: SessionMessage = {
          id: `pending-${optimistic.createdAt}`,
          type: "user",
          text: optimistic.text,
          files: optimistic.files,
          time: { created: optimistic.createdAt },
        };
        messages = [...messages, pending];
      }
    }
    return mergeStreamMessages(messages, streamState, selectedId);
  }, [context.data, optimistic, selectedId, streamState]);

  const defaultChatAgent = (session: Session | null) =>
    chatAgents.find((item) => item.id === session?.agent)?.id ?? chatAgents[0]?.id ?? "factory";

  const openNewChat = () => {
    setNotice(null);
    draftAttachments.clear();
    setNewChat({
      mode: "new",
      title: "",
      agent: defaultChatAgent(selected),
      model: selected?.model ? `${selected.model.providerID}/${selected.model.id}` : "",
      profileId: profileSuggestion.data?.profile?.id ?? "",
      prompt: "",
      objective: "",
      parentId: null,
      parentTitle: "",
      generation: 0,
      titleTouched: false,
      profileTouched: false,
      handoff: null,
    });
  };

  const buildCurrentHandoff = async (objective: string): Promise<Handoff | null> => {
    if (!selected) return null;
    const repo = await api.repoStatus(directory).catch(() => null);
    let decisions: string[] = [];
    try {
      const result = await rpc<{ memories: Array<{ title?: string | null; content: string }> }>(
        "memory.list",
        { project_id: projectId, kind: "decision", search: objective, limit: 4 },
        directory,
      );
      decisions = (result.memories ?? []).map((memory) =>
        memory.title ? `${memory.title}: ${memory.content}` : memory.content,
      );
    } catch {
      // La memoria es opcional; el traspaso sigue con el historial y el repo.
    }
    return buildHandoff({
      session: selected,
      messages: context.data ?? [],
      repo,
      decisions,
      objective,
    });
  };

  const startContinuation = (
    objective: string,
    promptText: string,
    meta: HandoffMeta | null,
    generation: number,
    parentId: string,
    parentTitle: string,
  ) => {
    setNewChat({
      mode: "continuation",
      title: titleForHandoff(objective, generation),
      agent: defaultChatAgent(selected),
      model: selected?.model ? `${selected.model.providerID}/${selected.model.id}` : "",
      profileId: profileSuggestion.data?.profile?.id ?? "",
      prompt: promptText,
      objective,
      parentId,
      parentTitle,
      generation,
      titleTouched: false,
      profileTouched: false,
      handoff: meta,
    });
  };

  const openContinuation = async () => {
    if (!selected) return;
    setNotice(null);
    draftAttachments.clear();
    const objective = baseTitle(selected.title) || "Sesión";
    ensureRoot(selected.id, selected.title);
    const generation = generationForChild(selected.id, selected.title);
    startContinuation(objective, "", null, generation, selected.id, selected.title ?? selected.id);
    const handoff = await buildCurrentHandoff(objective);
    if (!handoff) return;
    setNewChat((current) =>
      current && current.mode === "continuation" && !current.prompt
        ? {
            ...current,
            prompt: handoff.text,
            handoff: { tokens: handoff.tokens, dropped: handoff.dropped, pinned: [] },
          }
        : current,
    );
  };

  const openCheckpoint = async () => {
    if (!selected) return;
    setNotice(null);
    draftAttachments.clear();
    const objective = baseTitle(selected.title) || "Sesión";
    ensureRoot(selected.id, selected.title);
    const generation = generationForChild(selected.id, selected.title);
    const handoff = await buildCurrentHandoff(objective);
    if (!handoff) return;
    saveCheckpoint(selected.id, handoff);
    setNotice(`Checkpoint guardado (~${handoff.tokens} tokens). Revísalo antes de crear la sesión.`);
    startContinuation(
      handoff.objective,
      handoff.text,
      { tokens: handoff.tokens, dropped: handoff.dropped, pinned: [] },
      generation,
      selected.id,
      selected.title ?? selected.id,
    );
  };

  const selectSession = (id: string) => {
    setListOpen(false);
    if (id === selectedId) return;
    setSelectedId(id);
    setNotice(null);
  };

  const updatePrompt = (value: string) => {
    setCommandDismissed(false);
    setPrompt(value);
    if (selectedId) writeDraft(selectedId, value);
  };

  const sendPrompt = () => {
    const text = prompt.trim();
    if (!selectedId) return;
    if ((!text && attachments.files.length === 0) || send.isPending || attachments.reading) return;
    send.mutate({ sessionId: selectedId, text, files: attachments.files });
  };

  // Clasificación del borrador con retardo: no se recalcula en cada tecla.
  useEffect(() => {
    const timer = setTimeout(() => setDetectPrompt(prompt), 600);
    return () => clearTimeout(timer);
  }, [prompt]);

  const commandMatches = useMemo(
    () => (commandDismissed ? [] : suggestCommands(prompt)),
    [prompt, commandDismissed],
  );
  const commandOpen = commandMatches.length > 0 && !prompt.includes("\n");
  const activeCommandIndex = commandMatches.length
    ? commandIndex % commandMatches.length
    : 0;

  const liveRecommendation = useMemo(
    () => combinePromptAndProject(analyzePrompt(detectPrompt), profileSuggestion.data),
    [detectPrompt, profileSuggestion.data],
  );
  const liveProfile = useMemo(
    () =>
      (profiles.data?.profiles ?? []).find(
        (item) => item.name === liveRecommendation.recommended,
      ) ?? null,
    [profiles.data, liveRecommendation.recommended],
  );

  const draftRecommendation = useMemo(
    () => combinePromptAndProject(analyzePrompt(newChat?.prompt ?? ""), profileSuggestion.data),
    [newChat?.prompt, profileSuggestion.data],
  );
  const draftProfile = useMemo(
    () =>
      (profiles.data?.profiles ?? []).find(
        (item) => item.name === draftRecommendation.recommended,
      ) ?? null,
    [profiles.data, draftRecommendation.recommended],
  );

  useEffect(() => {
    if (!newChat || newChat.profileTouched || !draftProfile) return;
    setNewChat((current) =>
      current && !current.profileTouched && current.profileId !== draftProfile.id
        ? { ...current, profileId: draftProfile.id }
        : current,
    );
  }, [draftProfile?.id, newChat?.profileTouched]);

  const showStatus = async () => {
    const repo = await api.repoStatus(directory).catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    const sessionLine = selected
      ? `Sesión: ${selected.title ?? selected.id}\nContexto: ${formatCompact(contextTokens)} / ${
          contextLimit ? formatCompact(contextLimit) : "?"
        } (${contextRatio} %)\nCoste: ${formatUsd(selected.cost)}`
      : "Sin sesión seleccionada.";
    setCommandPanel({ title: "Estado", body: formatRepoStatus(repo, sessionLine) });
  };

  const runCommand = (name: string, arg: string) => {
    updatePrompt("");
    switch (name) {
      case "models": {
        const options = modelsByProvider.flatMap(([provider, list]) =>
          list.map((item) => ({
            label: `${provider}/${item.modelId} — ${item.name ?? item.modelId}`,
            value: `${provider}/${item.modelId}`,
          })),
        );
        if (arg) {
          const exists = options.some((option) => option.value === arg);
          if (!exists) {
            setNotice(`Modelo no encontrado: ${arg}. Usa /models para ver la lista.`);
            return;
          }
          switchModel.mutate(arg);
          setNotice(`Modelo cambiado a ${arg}.`);
          return;
        }
        setCommandPicker({
          title: "Modelos",
          options,
          onPick: (value) => {
            switchModel.mutate(value);
            setCommandPicker(null);
            setNotice(`Modelo cambiado a ${value}.`);
          },
        });
        return;
      }
      case "agent": {
        const options = chatAgents.map((item) => ({
          label: `${item.id} — ${item.mode}`,
          value: item.id,
        }));
        if (arg) {
          const exists = options.some((option) => option.value === arg);
          if (!exists) {
            setNotice(`Agente no encontrado: ${arg}. Usa /agent para ver la lista.`);
            return;
          }
          switchAgent.mutate(arg);
          setNotice(`Agente cambiado a ${arg}.`);
          return;
        }
        setCommandPicker({
          title: "Agentes",
          options,
          onPick: (value) => {
            switchAgent.mutate(value);
            setCommandPicker(null);
            setNotice(`Agente cambiado a ${value}.`);
          },
        });
        return;
      }
      case "status":
        void showStatus();
        return;
      case "continue":
        void openContinuation();
        return;
      case "checkpoint":
        void openCheckpoint();
        return;
      case "cd": {
        if (arg) {
          const needle = arg.toLowerCase();
          const match = projects.find(
            (item) =>
              item.id === arg ||
              item.canonical.toLowerCase() === needle ||
              item.canonical.toLowerCase().endsWith(`/${needle}`) ||
              item.canonical.split("/").pop()?.toLowerCase() === needle,
          );
          if (!match) {
            setNotice(`Proyecto no encontrado: ${arg}. Usa /cd para ver la lista.`);
            return;
          }
          setProjectId(match.id);
          setNotice(`Proyecto activo: ${match.canonical}`);
          return;
        }
        setCommandPicker({
          title: "Proyectos",
          options: projects.map((item) => ({ label: item.canonical, value: item.id })),
          onPick: (value) => {
            const match = projects.find((item) => item.id === value);
            setProjectId(value);
            setCommandPicker(null);
            setNotice(match ? `Proyecto activo: ${match.canonical}` : "Proyecto cambiado.");
          },
        });
        return;
      }
      case "help":
        setCommandPanel({ title: "Comandos", body: helpText() });
        return;
      default:
        setNotice(`Comando no reconocido: /${name}. Usa /help.`);
    }
  };

  const liveTone = live.status === "live" ? "live" : live.status === "offline" ? "offline" : "connecting";
  const liveLabel =
    live.status === "live"
      ? "En vivo"
      : live.status === "offline"
        ? "Sin conexión"
        : live.status === "reconnecting"
          ? "Reconectando…"
          : "Conectando…";

  const totalSessions = filtered.length;
  const draftTokens = newChat ? estimateTokens(newChat.prompt) : 0;
  const draftLineage =
    newChat?.mode === "continuation" && newChat.parentId
      ? lineageChain(newChat.parentId)
      : [];
  const parentSession = newChat?.parentId
    ? allSessions.find((session) => session.id === newChat.parentId) ?? null
    : null;
  const existingCheckpoint = newChat?.parentId ? readCheckpoint(newChat.parentId) : null;
  const pendingFormReply: FormReplyState | null =
    replyForm.isPending && replyForm.variables
      ? { formId: replyForm.variables.form.id, action: "reply" }
      : cancelForm.isPending && cancelForm.variables
        ? { formId: cancelForm.variables.id, action: "cancel" }
        : null;

  const lineageBody = (sessionId: string) => {
    const chain = lineageChain(sessionId);
    const children = childrenOf(sessionId);
    if (chain.length === 0) {
      return "Sin linaje registrado en este dispositivo. Se creará al usar /continue o /checkpoint.";
    }
    const lines = [
      "Cadena raíz → esta sesión:",
      ...chain.map((entry) => `- ${entry.title} (parte ${entry.generation + 1})`),
    ];
    if (children.length > 0) {
      lines.push("", "Hijas directas:", ...children.map((entry) => `- ${entry.title} (parte ${entry.generation + 1})`));
    }
    lines.push(
      "",
      "El linaje se guarda en localStorage; no se sincroniza entre dispositivos hasta la etapa 2.",
    );
    return lines.join("\n");
  };

  const togglePin = (section: HandoffSection) => {    setNewChat((current) => {
      if (!current) return current;
      const pinned = current.handoff?.pinned ?? [];
      const nextPinned = pinned.includes(section)
        ? pinned.filter((item) => item !== section)
        : [...pinned, section];
      const text = applyPinnedSections(current.prompt, nextPinned);
      return {
        ...current,
        prompt: text,
        handoff: current.handoff
          ? { ...current.handoff, pinned: nextPinned, tokens: estimateTokens(text) }
          : { tokens: estimateTokens(text), dropped: [], pinned: nextPinned },
      };
    });
  };
  return (
    <div className="flex h-[calc(var(--app-height,100dvh)-6.5rem-3.5rem-env(safe-area-inset-bottom))] gap-3 lg:h-[calc(var(--app-height,100dvh)-6.5rem)]">
      {listOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setListOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[86vw] max-w-[330px] flex-col border-r border-line bg-carbon-900 transition-transform duration-200 lg:static lg:z-auto lg:w-[300px] lg:max-w-none lg:shrink-0 lg:translate-x-0 lg:rounded-xl lg:border lg:border-line-soft",
          listOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <SessionList
          sessions={filtered}
          runningIds={visibleRunning}
          attentionIds={attentionIds}
          selectedId={selectedId}
          loading={sessions.isLoading}
          liveLabel={liveLabel}
          liveTone={liveTone}
          query={query}
          onQueryChange={setQuery}
          onlyProject={onlyProject}
          onOnlyProjectChange={setOnlyProject}
          showSubagents={showSubagents}
          onShowSubagentsChange={setShowSubagents}
          onSelect={selectSession}
          onDelete={setDeleteTarget}
          onNewChat={openNewChat}
          onRetry={() => void sessions.refetch()}
          error={sessions.error}
          projectLabel={project ? shortPath(project.canonical) : undefined}
          hasMore={Boolean(nextCursor)}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMoreSessions()}
        />
      </aside>

      <section className="surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
            <div className="mb-3 grid size-12 place-items-center rounded-2xl border border-violet/30 bg-violet/10 text-violet-soft">
              <MessagesSquare size={22} />
            </div>
            <h2 className="text-base font-semibold text-ink">Elige una conversación</h2>
            <p className="mt-1 max-w-sm text-xs leading-5 text-muted">
              Abre una sesión existente o crea un chat nuevo. El historial y el estado se actualizan en
              tiempo real.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <Button variant="primary" onClick={openNewChat}>
                <MessageSquarePlus size={14} /> Nuevo chat
              </Button>
              <Button variant="ghost" className="lg:hidden" onClick={() => setListOpen(true)}>
                <MessagesSquare size={14} /> Ver sesiones ({totalSessions})
              </Button>
            </div>
          </div>
        ) : (
          <>
            <header className="flex items-start gap-2.5 border-b border-line-soft px-3 py-2.5 lg:gap-3 lg:px-4 lg:py-3">
              <button
                className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-carbon-900 text-muted hover:text-ink lg:hidden"
                onClick={() => setListOpen(true)}
                aria-label="Abrir lista de sesiones"
              >
                <MessagesSquare size={15} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-semibold text-ink">
                    {selected.title ?? selected.id}
                  </h2>
                  {selected.parentID ? (
                    <span className="rounded border border-line px-1 py-px text-[9px] uppercase tracking-wide text-faint">
                      subagente
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                      waitingApproval
                        ? "border-warning/40 bg-warning/10 text-warning"
                        : liveTone === "live"
                          ? "border-success/25 bg-success/10 text-success"
                          : liveTone === "connecting"
                            ? "border-warning/25 bg-warning/10 text-warning"
                            : "border-danger/25 bg-danger/10 text-danger",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        waitingApproval
                          ? "animate-pulse bg-warning"
                          : liveTone === "live"
                            ? "bg-success"
                            : liveTone === "connecting"
                              ? "bg-warning"
                              : "bg-danger",
                      )}
                    />
                    {waitingApproval
                      ? `Esperando tu intervención${
                          pendingPermissions.length + pendingForms.length > 1
                            ? ` (${pendingPermissions.length + pendingForms.length})`
                            : ""
                        }`
                      : running
                        ? "Trabajando"
                        : liveLabel}
                  </span>
                </div>
                <div className="mt-1 hidden flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-faint sm:flex">
                  <span className="font-mono">{selected.id.slice(0, 16)}…</span>
                  <span className="text-line">·</span>
                  <span className="truncate">{shortPath(selected.location?.directory)}</span>
                  <span className="text-line">·</span>
                  <span>{formatCompact(sessionTotalTokens(selected))} tok</span>
                  <span className="text-line">·</span>
                  <span>{formatUsd(selected.cost)}</span>
                  <span className="text-line">·</span>
                  <span>activa {relativeTime(selected.time.updated)}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-faint sm:hidden">
                  <span className="truncate">{selected.agent}</span>
                  <span className="text-line">·</span>
                  <span className="truncate font-mono">{selected.model?.id ?? "modelo"}</span>
                  <span className="text-line">·</span>
                  <span>{relativeTime(selected.time.updated)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  className="hidden size-8 place-items-center rounded-lg border border-line bg-carbon-900 text-muted transition-colors hover:text-ink disabled:opacity-40 sm:grid"
                  onClick={refresh}
                  title="Actualizar ahora"
                  disabled={sessions.isFetching || context.isFetching}
                >
                  <RefreshCw size={14} className={cn(sessions.isFetching || context.isFetching ? "animate-spin" : undefined)} />
                </button>
                <button
                  className="hidden size-8 place-items-center rounded-lg border border-line bg-carbon-900 text-muted transition-colors hover:text-ink sm:grid"
                  onClick={openNewChat}
                  title="Nuevo chat"
                >
                  <Plus size={15} />
                </button>
                <button
                  className="grid size-8 place-items-center rounded-lg border border-line bg-carbon-900 text-muted transition-colors hover:text-ink"
                  onClick={() =>
                    setCommandPanel({
                      title: "Linaje de sesiones",
                      body: lineageBody(selected.id),
                    })
                  }
                  title="Linaje de sesiones"
                >
                  <GitBranch size={14} />
                </button>
                <button
                  className="grid size-8 place-items-center rounded-lg border border-line bg-carbon-900 text-muted transition-colors hover:border-danger/40 hover:text-danger"
                  onClick={() => setDeleteTarget(selected)}
                  title="Eliminar chat"
                >
                  <Trash2 size={14} />
                </button>
                {running ? (
                  <Button
                    variant="danger"
                    className="h-8 px-2 text-xs sm:px-2.5"
                    onClick={() => selectedId && interrupt.mutate(selectedId)}
                    disabled={interrupt.isPending}
                    title="Interrumpir la ejecución"
                  >
                    <CircleStop size={13} /> <span className="hidden sm:inline">Detener</span>
                  </Button>
                ) : null}
              </div>
            </header>

            <div className="grid grid-cols-2 gap-2 border-b border-line-soft bg-carbon-950/40 px-3 py-2 sm:flex sm:flex-wrap sm:items-center lg:px-4">
              <label className="col-span-2 flex min-w-0 items-center gap-1.5 text-[10px] text-faint sm:col-span-1">
                <span className="hidden shrink-0 font-mono sm:inline">perfil</span>
                <select
                  className="h-7 w-full min-w-0 rounded-md border border-line bg-carbon-900 px-2 text-[11px] text-ink outline-none focus:border-violet sm:max-w-[190px]"
                  value={profileId}
                  onChange={(event) => {
                    const next = event.target.value;
                    setProfileId(next);
                    applyProfile.mutate(next);
                  }}
                  disabled={!selectedId || running || applyProfile.isPending}
                  title="Aplica un perfil de modelos a todos los agentes y cambia el modelo de esta sesión"
                >
                  {profileId && !(profiles.data?.profiles ?? []).some((item) => item.id === profileId) ? (
                    <option value={profileId}>perfil actual</option>
                  ) : null}
                  {(profiles.data?.profiles ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.id === profiles.data?.applied_profile_id ? " · aplicado" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 items-center gap-1.5 text-[10px] text-faint">
                <Settings2 size={11} className="hidden shrink-0 sm:block" />
                <select
                  className="h-7 w-full min-w-0 rounded-md border border-line bg-carbon-900 px-2 text-[11px] text-ink outline-none focus:border-violet sm:max-w-[170px]"
                  value={agent}
                  onChange={(event) => {
                    setAgent(event.target.value);
                    switchAgent.mutate(event.target.value);
                  }}
                  title="Agente de la sesión"
                >
                  {(agents.data ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id} ({item.mode})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 items-center gap-1.5 text-[10px] text-faint">
                <span className="hidden shrink-0 font-mono sm:inline">modelo</span>
                <select
                  className="h-7 w-full min-w-0 rounded-md border border-line bg-carbon-900 px-2 font-mono text-[10px] text-ink outline-none focus:border-violet sm:max-w-[240px]"
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    switchModel.mutate(event.target.value);
                  }}
                  title="Modelo de la sesión"
                >
                  {model &&
                  !(modelsByProvider ?? []).some(([, list]) =>
                    list.some((item) => `${item.providerId}/${item.modelId}` === model),
                  ) ? (
                    <option value={model}>{model}</option>
                  ) : null}
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
              {contextLimit ? (
                <div
                  className="col-span-2 flex min-w-0 items-center gap-2 sm:col-span-1 sm:ml-auto sm:min-w-[160px]"
                  title="Contexto usado por la sesión"
                >
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-carbon-800 sm:w-24 sm:flex-none">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        contextRatio >= 85 ? "bg-danger" : contextRatio >= 60 ? "bg-warning" : "bg-violet",
                      )}
                      style={{ width: `${Math.max(contextRatio, contextTokens > 0 ? 3 : 0)}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      "shrink-0 whitespace-nowrap text-[10px] tabular-nums",
                      contextRatio >= 85 ? "text-danger" : contextRatio >= 60 ? "text-warning" : "text-faint",
                    )}
                  >
                    {formatCompact(contextTokens)} / {formatCompact(contextLimit)}
                  </span>
                </div>
              ) : null}
            </div>

            {notice ? (
              <div className="flex items-start gap-2 border-b border-warning/25 bg-warning/10 px-4 py-2 text-[11px] text-warning">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{notice}</span>
                <button className="shrink-0 text-warning/70 hover:text-warning" onClick={() => setNotice(null)}>
                  <X size={12} />
                </button>
              </div>
            ) : null}

            {longSession ? (
              <div className="flex flex-wrap items-center gap-3 border-b border-warning/25 bg-warning/[0.06] px-4 py-2.5">
                <AlertTriangle size={14} className="shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium text-warning">Sesión larga</p>
                  <p className="mt-0.5 text-[10px] leading-4 text-muted">
                    {formatCompact(sessionTotalTokens(selected))} tokens acumulados
                    {contextLimit && contextTokens > 0
                      ? ` · contexto al ${contextRatio} %`
                      : ""}
                    . Continúa en una sesión nueva con un resumen editable para no arrastrar todo el historial.
                  </p>
                </div>
                <Button
                  variant="default"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  onClick={openContinuation}
                  disabled={context.isLoading}
                >
                  <ArrowRight size={12} /> Continuar en nueva sesión
                </Button>
              </div>
            ) : null}

            <FormsPanel
              forms={pendingForms}
              pending={pendingFormReply}
              error={replyForm.error ?? cancelForm.error}
              onReply={(form, answer) => replyForm.mutate({ form, answer })}
              onCancel={(form) => cancelForm.mutate(form)}
            />

            <PermissionsPanel
              requests={pendingPermissions}
              pending={
                replyPermission.isPending && replyPermission.variables
                  ? {
                      requestId: replyPermission.variables.request.id,
                      decision: replyPermission.variables.decision,
                    }
                  : null
              }
              error={replyPermission.error}
              onReply={(request, decision, message) =>
                replyPermission.mutate({ request, decision, message })
              }
            />

            <Transcript
              messages={transcript}
              running={running}
              loading={context.isLoading}
              error={context.error}
              onRetry={() => void context.refetch()}
              sessionId={selected.id}
            />

            {liveProfile && liveRecommendation.confidence >= 0.62 && liveProfile.id !== profileId && !running ? (
              <div className="border-t border-violet/20 bg-violet/[0.06] px-3 py-2 lg:px-6">
                <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 text-[11px] text-violet-soft">
                  <Sparkles size={12} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    Perfil sugerido para este pedido: <strong>{liveProfile.name}</strong> (
                    {Math.round(liveRecommendation.confidence * 100)} %).{" "}
                    {liveRecommendation.reasons[0] ?? "Encaja con el prompt."}
                  </span>
                  <button
                    type="button"
                    className="rounded-md border border-violet/40 px-2 py-0.5 font-medium text-violet-soft transition-colors hover:bg-violet/15"
                    onClick={() => {
                      setProfileId(liveProfile.id);
                      applyProfile.mutate(liveProfile.id);
                    }}
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            ) : null}

            <div className="border-t border-line-soft bg-carbon-900/80 px-3 py-3 lg:px-6">
              <div className="mx-auto w-full max-w-3xl">
                <div
                  className={cn(
                    "relative rounded-xl border bg-carbon-950 px-3 py-2.5 transition-colors focus-within:border-violet/60",
                    dragging ? "border-violet ring-1 ring-violet/30" : "border-line",
                  )}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                    setDragging(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    if (event.dataTransfer.files.length) void addAttachmentsToCurrent(event.dataTransfer.files);
                  }}
                >
                  <CommandMenu
                    commands={commandOpen ? commandMatches : []}
                    activeIndex={activeCommandIndex}
                    onPick={(command) => {
                      updatePrompt(`/${command.name} `);
                      setCommandIndex(0);
                      textareaRef.current?.focus();
                    }}
                  />
                  <AttachmentChips
                    files={attachments.files}
                    onRemove={attachments.remove}
                    error={attachments.error}
                    reading={attachments.reading}
                  />
                  <textarea
                    ref={textareaRef}
                    rows={1}
                    value={prompt}
                    onChange={(event) => updatePrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (commandOpen) {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          setCommandIndex((index) => (index + 1) % commandMatches.length);
                          return;
                        }
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          setCommandIndex(
                            (index) => (index - 1 + commandMatches.length) % commandMatches.length,
                          );
                          return;
                        }
                        if (event.key === "Tab") {
                          event.preventDefault();
                          const command = commandMatches[activeCommandIndex];
                          if (command) updatePrompt(`/${command.name} `);
                          setCommandIndex(0);
                          return;
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setCommandDismissed(true);
                          return;
                        }
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          const command = commandMatches[activeCommandIndex];
                          if (command) runCommand(command.name, "");
                          return;
                        }
                      }
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        const parsed = parseSlash(prompt);
                        if (parsed) {
                          if (findCommand(parsed.name)) runCommand(parsed.name, parsed.arg);
                          else setNotice(`Comando no reconocido: /${parsed.name}. Usa /help.`);
                          return;
                        }
                        sendPrompt();
                      }
                    }}
                    onPaste={(event) => {
                      const pasted = filesFromClipboard(event.clipboardData);
                      if (pasted.length > 0) {
                        event.preventDefault();
                        void addAttachmentsToCurrent(pasted);
                      }
                    }}
                    placeholder={
                      dragging
                        ? "Suelta los archivos para adjuntarlos…"
                        : waitingApproval
                          ? "El agente espera tu aprobación o unos datos arriba…"
                          : running
                            ? "El agente está trabajando. Tu mensaje se encolará…"
                            : "Escribe un mensaje… (Enter para enviar, Shift+Enter para salto de línea)"
                    }
                    className="max-h-[220px] min-h-[26px] w-full resize-none bg-transparent text-[13px] leading-6 text-ink outline-none placeholder:text-faint"
                  />
                  <div className="mt-1.5 flex items-center gap-2">
                    <AttachmentButton onAdd={addAttachmentsToCurrent} disabled={send.isPending} />
                    <span className="hidden text-[10px] text-faint sm:inline">
                      {running ? "En ejecución · puedes detenerla" : "Adjunta imágenes o documentos"}
                    </span>
                    {contextLimit && contextTokens > 0 ? (
                      <span className="ml-auto text-[10px] text-faint sm:hidden">
                        {contextRatio}% contexto
                      </span>
                    ) : null}
                    <Button
                      variant="primary"
                      className="ml-auto h-8 px-3 text-xs"
                      onClick={sendPrompt}
                      disabled={
                        (!prompt.trim() && attachments.files.length === 0) ||
                        send.isPending ||
                        attachments.reading
                      }
                      title="Enviar mensaje (Enter)"
                    >
                      <Send size={13} /> Enviar
                    </Button>
                  </div>
                </div>
                {send.isError ? (
                  <p className="mt-1.5 text-[11px] text-danger">
                    {send.error instanceof Error ? send.error.message : String(send.error)}
                  </p>
                ) : (
                  <p className="mt-1.5 truncate text-[10px] text-faint">
                    Proyecto: {project ? shortPath(project.canonical) : "—"} · Coste de la sesión:{" "}
                    {formatUsd(selected.cost)}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      <Modal
        open={Boolean(newChat)}
        title={newChat?.mode === "continuation" ? "Continuar en nueva sesión" : "Nuevo chat"}
        description={
          newChat?.mode === "continuation"
            ? "Traspaso estructurado: último pedido completo, estado, repo y decisiones. Editable; nada se envía hasta crear la sesión."
            : "Una sesión limpia evita arrastrar historial y tokens."
        }
        onClose={() => setNewChat(null)}
        width={promptExpanded ? "max-w-5xl" : "max-w-2xl"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewChat(null)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              onClick={() => newChat && createChat.mutate({ ...newChat, files: draftAttachments.files })}
              disabled={
                !newChat ||
                createChat.isPending ||
                !newChat.agent ||
                draftAttachments.reading ||
                (newChat.mode === "continuation" && !newChat.prompt.trim())
              }
            >
              {createChat.isPending ? "Creando…" : "Crear chat"}
            </Button>
          </>
        }
      >
        {newChat ? (
          <div className="space-y-3">
            {newChat.mode === "continuation" ? (
              <div className="rounded-lg border border-violet/25 bg-violet/[0.06] px-3 py-2 text-[10px] leading-4 text-muted">
                <p className="font-medium text-violet-soft">Traspaso estructurado</p>
                <p className="mt-0.5">
                  Se lleva el objetivo, el último pedido textual completo, el estado, las decisiones,
                  el repo, los bugs y las restricciones. Todo es editable.
                </p>
                <p className="mt-1 text-faint">
                  Linaje:{" "}
                  {draftLineage.length
                    ? draftLineage.map((entry) => entry.title).join(" → ")
                    : "raíz"}{" "}
                  → esta sesión. Se guarda en este dispositivo; la sincronización entre dispositivos
                  llega en la etapa 2.
                </p>
              </div>
            ) : null}
            {newChat.mode === "continuation" ? (
              <Field
                label="Objetivo"
                hint="Se usa para el título y para el traspaso. Cámbialo si el objetivo ya no es el mismo."
              >
                <input
                  className="field"
                  value={newChat.objective}
                  onChange={(event) => {
                    const objective = event.target.value;
                    setNewChat({
                      ...newChat,
                      objective,
                      title: newChat.titleTouched
                        ? newChat.title
                        : titleForHandoff(objective, newChat.generation),
                    });
                  }}
                  placeholder="Objetivo de la sesión"
                />
              </Field>
            ) : null}
            <Field label="Título" hint="Opcional; si lo dejas vacío se usa el primer prompt.">
              <input
                className="field"
                value={newChat.title}
                onChange={(event) =>
                  setNewChat({ ...newChat, title: event.target.value, titleTouched: true })
                }
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
              label="Perfil de modelos"
              hint={
                draftRecommendation.source === "prompt" && draftRecommendation.recommended
                  ? `Sugerido por el pedido: ${draftRecommendation.recommended} (${Math.round(
                      draftRecommendation.confidence * 100,
                    )} %). Puedes cambiarlo.`
                  : profileSuggestion.data?.profile
                    ? `Recomendado para este proyecto: ${profileSuggestion.data.profile.name} (${Math.round(
                        profileSuggestion.data.confidence * 100,
                      )} % confianza). Puedes cambiarlo.`
                    : "Se aplica a los agentes y al modelo de la sesión. Puedes cambiarlo antes de crear."
              }
            >
              <select
                className="field"
                value={newChat.profileId}
                onChange={(event) =>
                  setNewChat({ ...newChat, profileId: event.target.value, profileTouched: true })
                }
              >
                <option value="">Sin perfil (modelo del agente)</option>
                {(profiles.data?.profiles ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.id === draftProfile?.id ? " · sugerido" : ""}
                    {item.id === profiles.data?.applied_profile_id ? " · aplicado" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <AttachmentChips
              files={draftAttachments.files}
              onRemove={draftAttachments.remove}
              error={draftAttachments.error}
              reading={draftAttachments.reading}
              compact
            />
            <Field
              label={newChat.mode === "continuation" ? "Traspaso (editable)" : "Primer prompt"}
              hint={
                newChat.mode === "continuation"
                  ? "Revisa el traspaso antes de enviarlo. El primer mensaje pide al asistente confirmar qué entendió."
                  : "Opcional. Puedes adjuntar archivos."
              }
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "text-[10px] tabular-nums",
                    draftTokens > 6000 ? "text-warning" : "text-faint",
                  )}
                >
                  ~{draftTokens} tokens
                  {draftTokens > 6000 ? " · supera el presupuesto recomendado (4-6k)" : ""}
                </span>
                <button
                  type="button"
                  className="ml-auto rounded-md border border-line px-2 py-0.5 text-[10px] text-violet-soft transition-colors hover:bg-violet/10"
                  onClick={() => setPromptExpanded((value) => !value)}
                >
                  {promptExpanded ? "Reducir" : "Ampliar"}
                </button>
              </div>
              <textarea
                className={cn(
                  "field resize-y text-xs leading-5",
                  promptExpanded
                    ? "min-h-[55vh]"
                    : newChat.mode === "continuation"
                      ? "min-h-64"
                      : "min-h-32",
                )}
                value={newChat.prompt}
                onChange={(event) => setNewChat({ ...newChat, prompt: event.target.value })}
                onPaste={(event) => {
                  const pasted = filesFromClipboard(event.clipboardData);
                  if (pasted.length > 0) {
                    event.preventDefault();
                    void draftAttachments.add(pasted);
                  }
                }}
                placeholder="Escribe el primer mensaje o adjunta archivos…"
              />
            </Field>
            {newChat.mode === "continuation" ? (
              <details className="rounded-lg border border-line bg-carbon-900 px-3 py-2 text-[11px] text-muted">
                <summary className="cursor-pointer text-faint">
                  Qué se lleva, qué se deja fuera y elementos fijados
                </summary>
                <div className="mt-2 space-y-2">
                  <p>
                    Se lleva: objetivo, último pedido completo, estado, hecho/pendiente, decisiones,
                    repo, bugs y restricciones.
                  </p>
                  <p>
                    Se deja fuera:{" "}
                    {(newChat.handoff?.dropped ?? []).join(" ") ||
                      "nada relevante; el traspaso está vacío hasta que termine de generarse."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(["lastRequest", "decisions", "constraints", "pending"] as HandoffSection[]).map(
                      (section) => (
                        <label
                          key={section}
                          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1"
                        >
                          <input
                            type="checkbox"
                            checked={newChat.handoff?.pinned.includes(section) ?? false}
                            onChange={() => togglePin(section)}
                          />
                          Fijar {HANDOFF_SECTION_LABELS[section]}
                        </label>
                      ),
                    )}
                  </div>
                  {existingCheckpoint ? (
                    <button
                      type="button"
                      className="text-[10px] text-violet-soft"
                      onClick={() =>
                        setNewChat({
                          ...newChat,
                          prompt: existingCheckpoint.text,
                          objective: existingCheckpoint.objective || newChat.objective,
                        })
                      }
                    >
                      Usar el checkpoint guardado (
                      {new Date(existingCheckpoint.createdAt).toLocaleString()})
                    </button>
                  ) : null}
                  {parentSession ? (
                    <button
                      type="button"
                      className="block text-[10px] text-faint underline decoration-line underline-offset-2"
                      onClick={() =>
                        setNewChat({
                          ...newChat,
                          prompt: buildHandoffPrompt(parentSession, context.data ?? []),
                        })
                      }
                    >
                      Usar el resumen anterior (método antiguo)
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}
            <div className="flex items-center gap-2">
              <AttachmentButton onAdd={draftAttachments.add} disabled={createChat.isPending} />
              <span className="text-[10px] text-faint">
                Imágenes o documentos · hasta 6 archivos de 8 MB
              </span>
            </div>
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

      <Modal
        open={Boolean(commandPicker)}
        title={commandPicker?.title ?? "Seleccionar"}
        onClose={() => setCommandPicker(null)}
        width="max-w-lg"
      >
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {(commandPicker?.options ?? []).map((option) => (
            <button
              key={option.value}
              type="button"
              className="w-full rounded-md border border-line px-3 py-2 text-left text-xs text-muted transition-colors hover:bg-carbon-900 hover:text-ink"
              onClick={() => commandPicker?.onPick(option.value)}
            >
              {option.label}
            </button>
          ))}
          {commandPicker && commandPicker.options.length === 0 ? (
            <p className="text-xs text-faint">Sin opciones disponibles.</p>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={Boolean(commandPanel)}
        title={commandPanel?.title ?? "Resultado"}
        onClose={() => setCommandPanel(null)}
        width="max-w-2xl"
        footer={<Button onClick={() => setCommandPanel(null)}>Cerrar</Button>}
      >
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-carbon-950 px-3 py-2 text-[11px] leading-5 text-muted">
          {commandPanel?.body ?? ""}
        </pre>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Eliminar chat"
        confirmLabel={deleteSession.isPending ? "Eliminando…" : "Eliminar chat"}
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteSession.mutate(deleteTarget.id)}
        message={
          <span>
            Se eliminará{" "}
            <span className="font-medium text-ink">{deleteTarget?.title ?? deleteTarget?.id}</span> y sus
            subagentes. Esta acción no se puede deshacer.
          </span>
        }
      />
    </div>
  );
}
