export interface Project {
  id: string;
  canonical: string;
  vcs?: string;
  time?: { created?: number; updated?: number; active?: number };
  sandboxes?: unknown[];
}

/** Estado de solo lectura del repositorio (`GET /api/repo/status`). */
export interface RepoStatus {
  ok: boolean;
  root?: string;
  branch?: string;
  last_commit?: string;
  dirty?: string[];
  clean?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache?: { read?: number; write?: number };
}

export interface Session {
  id: string;
  projectID: string;
  agent: string;
  model?: ModelRef;
  cost: number;
  tokens: TokenUsage;
  time: {
    created: number;
    updated: number;
    busy?: number;
    idle?: number;
    viewed?: number;
    archived?: number;
  };
  title?: string;
  outcome?: string;
  location?: { directory: string };
  parentID?: string;
}

export type PermissionDecision = "once" | "always" | "reject";

/**
 * Solicitud de permiso de OpenCode V2 (`permission.asked`).
 * `resources` son los comandos/rutas afectados y `save` las reglas que se
 * guardarían al responder «siempre».
 */
export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: "tool"; messageID: string; id: string };
  message?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  mode: string;
  model?: ModelRef;
  color?: string;
  steps?: number;
  permissions?: unknown[];
}

export interface CatalogModel {
  providerId: string;
  modelId: string;
  name: string | null;
  family: string | null;
  type: string;
  status: string;
  enabled: boolean;
  contextLimit: number | null;
  inputLimit: number | null;
  outputLimit: number | null;
  costInput: number | null;
  costOutput: number | null;
  costCacheRead: number | null;
  costCacheWrite: number | null;
  capabilities: { tools?: boolean; input?: string[]; output?: string[]; [key: string]: unknown };
  variants: unknown[];
  authorized: boolean;
  prohibited: boolean;
  notes: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogAgent {
  agentId: string;
  name: string | null;
  mode: string | null;
  description: string | null;
  role: string | null;
  modelProvider: string | null;
  modelId: string | null;
  modelVariant: string | null;
  steps: number | null;
  permissions: unknown[];
  source: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileAssignment {
  profileId?: string;
  agentId: string;
  providerId: string;
  modelId: string;
  variant?: string | null;
  locked?: boolean;
  maxCostUsd?: number | null;
  tokenBudget?: number | null;
  priority?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface Profile {
  id: string;
  name: string;
  description: string | null;
  mode: "auto" | "manual" | "hybrid";
  isDefault: boolean;
  policy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  assignments?: ProfileAssignment[];
  applied?: boolean;
}

export interface ProfileRecommendation {
  recommended: string;
  confidence: number;
  scores: Record<string, number>;
  reasons: string[];
  alternatives: Array<{ name: string; score: number }>;
  profile: { id: string; name: string } | null;
  available?: Array<{ id: string; name: string }>;
  signals?: {
    files?: number;
    codeFiles?: number;
    docFiles?: number;
    testFiles?: number;
    shellFiles?: number;
    monorepo?: boolean;
    linuxSignals?: string[];
    studySignals?: string[];
  };
}

export interface Health {
  ok: boolean;
  project_id: string;
  checked_at: string;
  models: number;
  agents: number;
  profiles: number;
  memory_available: boolean;
  default_profile: string | null;
  applied_profile_id?: string | null;
  applied_profile?: string | null;
}

export interface WorkOverview {
  project_id: string;
  tasks: Record<string, number>;
  plans: Record<string, number>;
  gates: Record<string, number>;
  reviews: Record<string, number>;
  recent: {
    tasks: Array<Record<string, unknown>>;
    gates: Array<Record<string, unknown>>;
    reviews: Array<Record<string, unknown>>;
  };
  model_usage: Array<{ model: string; cost: string | number; runs: number }>;
}

export interface WorkTask {
  id: string;
  project_id: string;
  project_path: string | null;
  title: string;
  acceptance_criteria: string;
  status: string;
  result: string | null;
  closure_report: unknown;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkPlan {
  id: string;
  project_id: string;
  title: string;
  status: string;
  autonomy: string;
  max_concurrency: number;
  review_round: number;
  review_exhausted: boolean;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  tasks_total: number;
  tasks_done: number;
  tasks_merged: number;
  tasks_running: number;
  tasks_failed: number;
}

export interface WorkGate {
  id: string;
  project_id: string;
  task_id: string | null;
  iteration: number;
  mode: string;
  status: string;
  summary: string | null;
  blocking_failures: unknown;
  warnings: unknown;
  git_branch: string | null;
  git_commit: string | null;
  created_at: string;
}

export interface WorkReview {
  id: string;
  project_id: string;
  task_id: string;
  role: string;
  model: string;
  verdict: string;
  findings: unknown;
  open_blocking: number;
  summary: string | null;
  gate_run_id: string | null;
  iteration: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: string | number | null;
  cost_source: string | null;
  created_at: string;
}

export interface MemoryItem {
  id: string;
  scope: string;
  projectId: string;
  kind: string;
  title: string | null;
  content: string;
  tags: string[];
  importance: number;
  pinned: boolean;
  sourceSession: string | null;
  entityKey?: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface MemoryStats {
  total: number;
  byScope: Record<string, number>;
  byKind: Record<string, number>;
  size: string | null;
  oldest: string | null;
  newest: string | null;
  available?: boolean;
}

export interface SessionStats {
  range: { from: number; to: number };
  sessions: number;
  subagents: number;
  prompts: number;
  steps: number;
  tokens: TokenUsage;
  cost: number;
  tools: { mode: string; totals: { calls: number; succeeded: number; failed: number; unfinished: number } };
  activeDays: number;
  streak: number;
  activity: Array<{ date: string; steps: number }>;
  models: Array<{ model: ModelRef; steps: number; tokens: TokenUsage; cost: number }>;
}

export interface AnalyticsSummary {
  project_id: string;
  days: number;
  source?: string;
  by_model: Array<{
    model: string;
    cost: string | number;
    tokens_input: string | number;
    tokens_output: string | number;
    runs: number;
  }>;
  by_role: Array<{ role: string; cost: string | number; runs: number }>;
  by_day: Array<{ day: string; cost: string | number; runs: number }>;
  totals: Record<string, unknown>;
}

export interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  path?: string;
  content?: string;
}

export interface McpServer {
  name: string;
  status?: { status?: string };
  title?: string;
  integrationID?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  activation?: string;
  package?: string;
}

export interface MessagePart {
  type: string;
  text?: string;
  tool?: string;
  name?: string;
  state?: { status?: string; input?: unknown; content?: Array<{ type: string; text?: string }> };
  [key: string]: unknown;
}

export interface PromptFileAttachment {
  data?: string;
  mime?: string;
  name?: string;
  description?: string;
  source?: { type: "inline" } | { type: "uri"; uri: string };
}

export interface SessionMessage {
  id: string;
  type: "user" | "assistant" | "tool" | string;
  text?: string;
  content?: MessagePart[];
  files?: PromptFileAttachment[];
  agent?: string;
  model?: ModelRef;
  tokens?: TokenUsage;
  time?: { created?: number; completed?: number };
  error?: { type?: string; message?: string } | unknown;
  cost?: number;
  [key: string]: unknown;
}

export interface AgentCatalogEntry {
  agentId: string;
  role: string;
  description: string;
  required?: boolean;
}

export interface AgentSelection {
  projectId: string;
  mode: "auto" | "manual" | "hybrid";
  selected: string[];
  recommended: string[];
  approved: string[];
  rationale: Record<string, string>;
  updatedAt: string;
}

export interface ExecutionRecord {
  id: string;
  projectId: string | null;
  phase: number | null;
  parentExecutionId: string | null;
  profileId: string | null;
  sessionId: string | null;
  agentId: string | null;
  providerId: string | null;
  modelId: string | null;
  role: string | null;
  taskId: string | null;
  planId: string | null;
  mode: string | null;
  selectionReason: string | null;
  attempt: number;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  weightedTokens: number;
  costUsd: number | null;
  costSource: string | null;
  budgetUnit: string | null;
  reservedWeightedTokens: number | null;
  reservedCostUsd: number | null;
  reservationSource: string | null;
  overrunRatio: number | null;
  status: string | null;
  error: string | null;
  gateRunId: string | null;
  priceVersion: string | null;
  toolVersions: Record<string, unknown>;
  metadata: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
}

export interface BudgetRecord {
  key: string;
  projectId: string;
  scope: string;
  planId: string | null;
  phase: number | null;
  taskId: string | null;
  tokenBudget: number | null;
  maxCostUsd: number | null;
  reservedWeightedTokens: number;
  reservedCostUsd: number;
  spentWeightedTokens: number;
  spentCostUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelHistoryRecord {
  providerId: string;
  modelId: string;
  runs: number;
  successes: number;
  avgCostUsd: number | null;
  avgTokens: number | null;
}
