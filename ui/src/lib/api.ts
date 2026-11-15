import { jsonRequest, type JsonRequestInit } from "./http";
import { sessionListSchema } from "./schemas";
import type {
  AgentInfo,
  CatalogModel as _CatalogModel,
  McpServer,
  ModelRef,
  Project,
  ProviderInfo,
  Session,
  SessionMessage,
  SessionStats,
  SkillInfo,
} from "./types";

function withLocation(path: string, directory?: string): string {
  if (!directory) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}location[directory]=${encodeURIComponent(directory)}`;
}

async function request<T>(path: string, init?: JsonRequestInit): Promise<T> {
  return jsonRequest<T>(path, {
    ...init,
    headers: {
      "x-factory-ui": "1",
      ...(init?.headers ?? {}),
    },
  });
}

export function unwrapList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

export const api = {
  projects: () => request<Project[] | { data: Project[] }>("/api/project").then((value) => unwrapList<Project>(value)),

  sessions: (limit = 60, options: { parentID?: string; directory?: string } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (options.parentID) params.set("parentID", options.parentID);
    if (options.directory) params.set("directory", options.directory);
    return request<{ data: Session[] }>(`/api/session?${params.toString()}`, {
      schema: sessionListSchema,
    }).then((value) => unwrapList<Session>(value));
  },

  createSession: (input: {
    title?: string;
    agent?: string;
    model?: ModelRef;
    directory?: string;
  }) =>
    request<{ data: Session }>("/api/session", {
      method: "POST",
      body: JSON.stringify({
        ...(input.title ? { title: input.title } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.directory ? { location: { directory: input.directory } } : {}),
      }),
    }).then((value) => value.data),

  session: (id: string) =>
    request<{ data: Session }>(`/api/session/${encodeURIComponent(id)}`).then((value) => value.data),

  activeSessions: () =>
    request<{ data: Record<string, { type?: string }> }>("/api/session/active").then((value) => value.data ?? {}),

  sessionContext: (id: string) =>
    request<{ data: SessionMessage[] }>(`/api/session/${encodeURIComponent(id)}/context`).then((value) =>
      unwrapList<SessionMessage>(value),
    ),

  deleteSession: (id: string) =>
    request<void>(`/api/session/${encodeURIComponent(id)}`, { method: "DELETE" }),

  prompt: (
    id: string,
    text: string,
    files?: Array<{ uri: string; name?: string; description?: string }>,
  ) =>
    request(`/api/session/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text, ...(files?.length ? { files } : {}) }),
    }),

  switchAgent: (id: string, agent: string) =>
    request(`/api/session/${encodeURIComponent(id)}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    }),

  switchModel: (id: string, model: ModelRef) =>
    request(`/api/session/${encodeURIComponent(id)}/model`, {
      method: "POST",
      body: JSON.stringify({ model }),
    }),

  interrupt: (id: string) =>
    request(`/api/session/${encodeURIComponent(id)}/interrupt`, { method: "POST" }),

  agents: (directory?: string) =>
    request<{ data: AgentInfo[] }>(withLocation("/api/agent", directory)).then((value) =>
      unwrapList<AgentInfo>(value),
    ),

  models: (directory?: string) =>
    request<unknown>(withLocation("/api/model", directory)).then((value) => unwrapList<_CatalogModel>(value)),

  skills: (directory?: string) =>
    request<{ data: SkillInfo[] }>(withLocation("/api/skill", directory)).then((value) =>
      unwrapList<SkillInfo>(value),
    ),

  mcp: (directory?: string) =>
    request<{ data: McpServer[] }>(withLocation("/api/mcp", directory)).then((value) =>
      unwrapList<McpServer>(value),
    ),

  providers: (directory?: string) =>
    request<{ data: ProviderInfo[] }>(withLocation("/api/provider", directory)).then((value) =>
      unwrapList<ProviderInfo>(value),
    ),

  config: (directory?: string) => request<unknown>(withLocation("/api/config", directory)),

  stats: (directory?: string) =>
    request<{ data: SessionStats }>(withLocation("/api/experimental/session/stats", directory)).then(
      (value) => value.data,
    ),

  usageLimits: (directory?: string) => request<unknown>(withLocation("/api/experimental/usage/limits", directory)),
};
