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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-factory-ui": "1",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 240)}`);
  }
  return (await response.json()) as T;
}

export function unwrapList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

export const api = {
  projects: () => request<Project[] | { data: Project[] }>("/api/project").then((value) => unwrapList<Project>(value)),

  sessions: (limit = 60) =>
    request<{ data: Session[] }>(`/api/session?limit=${limit}`).then((value) => unwrapList<Session>(value)),

  session: (id: string) =>
    request<{ data: Session }>(`/api/session/${encodeURIComponent(id)}`).then((value) => value.data),

  sessionContext: (id: string) =>
    request<{ data: SessionMessage[] }>(`/api/session/${encodeURIComponent(id)}/context`).then((value) =>
      unwrapList<SessionMessage>(value),
    ),

  prompt: (id: string, text: string) =>
    request(`/api/session/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
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
