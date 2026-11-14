/**
 * Model & Agent Management (MAM): capa de datos.
 *
 * Qué hace: sincroniza el catálogo real de modelos/agentes de OpenCode y
 * persiste perfiles de ejecución, asignaciones por rol, auditoría y registro de
 * ejecuciones. No toca `memories` ni `capture_state`.
 *
 * Qué accede: PostgreSQL de la fábrica. No ejecuta comandos ni lee archivos.
 */

import type { QueryFn } from "./db.js";

export interface ModelInput {
  providerId: string;
  modelId: string;
  name?: string | null;
  family?: string | null;
  type?: string;
  status?: string;
  enabled?: boolean;
  contextLimit?: number | null;
  inputLimit?: number | null;
  outputLimit?: number | null;
  costInput?: number | null;
  costOutput?: number | null;
  costCacheRead?: number | null;
  costCacheWrite?: number | null;
  capabilities?: Record<string, unknown>;
  variants?: unknown[];
}

export interface AgentInput {
  agentId: string;
  name?: string | null;
  mode?: string | null;
  description?: string | null;
  role?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  modelVariant?: string | null;
  steps?: number | null;
  permissions?: unknown[];
  source?: string | null;
}

export interface ModelRecord {
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
  capabilities: Record<string, unknown>;
  variants: unknown[];
  authorized: boolean;
  prohibited: boolean;
  notes: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRecord {
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

export type ProfileMode = "auto" | "manual" | "hybrid";

export interface ProfilePolicy {
  allowedProviders?: string[];
  allowedModels?: string[];
  prohibitedModels?: string[];
  requireTools?: boolean;
  minContext?: number;
  noSilentFallback?: boolean;
}

export interface ProfileAssignment {
  agentId: string;
  providerId: string;
  modelId: string;
  variant?: string | null;
  locked?: boolean;
  maxCostUsd?: number | null;
  maxTokens?: number | null;
  priority?: number;
}

export interface ProfileAssignmentRecord extends ProfileAssignment {
  profileId: string;
  locked: boolean;
  maxCostUsd: number | null;
  maxTokens: number | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionProfile {
  id: string;
  name: string;
  description: string | null;
  mode: ProfileMode;
  isDefault: boolean;
  policy: ProfilePolicy;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionProfileWithAssignments extends ExecutionProfile {
  assignments: ProfileAssignmentRecord[];
}

export interface ProfileInput {
  id?: string;
  name: string;
  description?: string | null;
  mode?: ProfileMode;
  isDefault?: boolean;
  policy?: ProfilePolicy;
  assignments: ProfileAssignment[];
}

export interface ModelFilter {
  providerId?: string;
  family?: string;
  status?: string;
  authorized?: boolean;
  prohibited?: boolean;
  enabled?: boolean;
  search?: string;
  limit?: number;
}

export interface ExecutionLogInput {
  profileId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  role?: string | null;
  taskId?: string | null;
  planId?: string | null;
  tokensInput?: number;
  tokensOutput?: number;
  tokensReasoning?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  costUsd?: number | null;
  costSource?: string | null;
  status?: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface MemoryRecord {
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
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface MemoryFilter {
  scope?: string;
  projectId?: string;
  kind?: string;
  search?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryStats {
  total: number;
  byScope: Record<string, number>;
  byKind: Record<string, number>;
  size: string | null;
  oldest: string | null;
  newest: string | null;
}

interface ProfileRow {
  id: string;
  name: string;
  description: string | null;
  mode: ProfileMode;
  is_default: boolean;
  policy: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AssignmentRow {
  profile_id: string;
  agent_id: string;
  provider_id: string;
  model_id: string;
  variant: string | null;
  locked: boolean;
  max_cost_usd: string | number | null;
  max_tokens: number | null;
  priority: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ModelRow {
  provider_id: string;
  model_id: string;
  name: string | null;
  family: string | null;
  type: string;
  status: string;
  enabled: boolean;
  context_limit: number | null;
  input_limit: number | null;
  output_limit: number | null;
  cost_input: string | number | null;
  cost_output: string | number | null;
  cost_cache_read: string | number | null;
  cost_cache_write: string | number | null;
  capabilities: unknown;
  variants: unknown;
  authorized: boolean;
  prohibited: boolean;
  notes: string | null;
  last_seen_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AgentRow {
  agent_id: string;
  name: string | null;
  mode: string | null;
  description: string | null;
  role: string | null;
  model_provider: string | null;
  model_id: string | null;
  model_variant: string | null;
  steps: number | null;
  permissions: unknown;
  source: string | null;
  last_seen_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

const ISO = (value: Date | string | null): string | null =>
  value instanceof Date ? value.toISOString() : value;

const numberOrNull = (value: string | number | null): number | null =>
  value === null || value === undefined ? null : Number(value);

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mapModel(row: ModelRow): ModelRecord {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    name: row.name,
    family: row.family,
    type: row.type,
    status: row.status,
    enabled: row.enabled,
    contextLimit: row.context_limit,
    inputLimit: row.input_limit,
    outputLimit: row.output_limit,
    costInput: numberOrNull(row.cost_input),
    costOutput: numberOrNull(row.cost_output),
    costCacheRead: numberOrNull(row.cost_cache_read),
    costCacheWrite: numberOrNull(row.cost_cache_write),
    capabilities: asObject(row.capabilities),
    variants: asArray(row.variants),
    authorized: row.authorized,
    prohibited: row.prohibited,
    notes: row.notes,
    lastSeenAt: ISO(row.last_seen_at) ?? "",
    createdAt: ISO(row.created_at) ?? "",
    updatedAt: ISO(row.updated_at) ?? "",
  };
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    agentId: row.agent_id,
    name: row.name,
    mode: row.mode,
    description: row.description,
    role: row.role,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    modelVariant: row.model_variant,
    steps: row.steps,
    permissions: asArray(row.permissions),
    source: row.source,
    lastSeenAt: ISO(row.last_seen_at) ?? "",
    createdAt: ISO(row.created_at) ?? "",
    updatedAt: ISO(row.updated_at) ?? "",
  };
}

function mapProfile(row: ProfileRow): ExecutionProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode: row.mode,
    isDefault: row.is_default,
    policy: asObject(row.policy) as ProfilePolicy,
    createdAt: ISO(row.created_at) ?? "",
    updatedAt: ISO(row.updated_at) ?? "",
  };
}

function mapAssignment(row: AssignmentRow): ProfileAssignmentRecord {
  return {
    profileId: row.profile_id,
    agentId: row.agent_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    variant: row.variant,
    locked: row.locked,
    maxCostUsd: numberOrNull(row.max_cost_usd),
    maxTokens: row.max_tokens,
    priority: row.priority,
    createdAt: ISO(row.created_at) ?? "",
    updatedAt: ISO(row.updated_at) ?? "",
  };
}

function mapMemoryRow(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    scope: String(row.scope),
    projectId: String(row.project_id ?? ""),
    kind: String(row.kind ?? "fact"),
    title: row.title === null ? null : String(row.title),
    content: String(row.content ?? ""),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    importance: Number(row.importance ?? 3),
    pinned: Boolean(row.pinned),
    sourceSession: row.source_session ? String(row.source_session) : null,
    createdAt: ISO(row.created_at as Date | string) ?? "",
    updatedAt: ISO(row.updated_at as Date | string) ?? "",
    lastUsedAt: row.last_used_at ? ISO(row.last_used_at as Date | string) : null,
    useCount: Number(row.use_count ?? 0),
  };
}

export class MamStore {
  constructor(private readonly query: QueryFn) {}

  async syncCatalog(models: ModelInput[], agents: AgentInput[]): Promise<{ models: number; agents: number }> {
    const modelPayload = models.map((model) => ({
      provider_id: model.providerId,
      model_id: model.modelId,
      name: model.name ?? null,
      family: model.family ?? null,
      type: model.type ?? "chat",
      status: model.status ?? "active",
      enabled: model.enabled ?? true,
      context_limit: model.contextLimit ?? null,
      input_limit: model.inputLimit ?? null,
      output_limit: model.outputLimit ?? null,
      cost_input: model.costInput ?? null,
      cost_output: model.costOutput ?? null,
      cost_cache_read: model.costCacheRead ?? null,
      cost_cache_write: model.costCacheWrite ?? null,
      capabilities: model.capabilities ?? {},
      variants: model.variants ?? [],
    }));

    if (modelPayload.length > 0) {
      await this.query(
        `INSERT INTO factory_models (
           provider_id, model_id, name, family, type, status, enabled,
           context_limit, input_limit, output_limit,
           cost_input, cost_output, cost_cache_read, cost_cache_write,
           capabilities, variants, last_seen_at, updated_at
         )
         SELECT provider_id, model_id, name, family, type, status, enabled,
                context_limit, input_limit, output_limit,
                cost_input, cost_output, cost_cache_read, cost_cache_write,
                capabilities, variants, now(), now()
         FROM jsonb_to_recordset($1::jsonb) AS x(
           provider_id text, model_id text, name text, family text, type text,
           status text, enabled boolean, context_limit integer, input_limit integer,
           output_limit integer, cost_input numeric, cost_output numeric,
           cost_cache_read numeric, cost_cache_write numeric,
           capabilities jsonb, variants jsonb
         )
         ON CONFLICT (provider_id, model_id) DO UPDATE SET
           name = EXCLUDED.name,
           family = EXCLUDED.family,
           type = EXCLUDED.type,
           status = EXCLUDED.status,
           enabled = EXCLUDED.enabled,
           context_limit = EXCLUDED.context_limit,
           input_limit = EXCLUDED.input_limit,
           output_limit = EXCLUDED.output_limit,
           cost_input = EXCLUDED.cost_input,
           cost_output = EXCLUDED.cost_output,
           cost_cache_read = EXCLUDED.cost_cache_read,
           cost_cache_write = EXCLUDED.cost_cache_write,
           capabilities = EXCLUDED.capabilities,
           variants = EXCLUDED.variants,
           last_seen_at = now(),
           updated_at = now()`,
        [JSON.stringify(modelPayload)],
      );
    }

    const agentPayload = agents.map((agent) => ({
      agent_id: agent.agentId,
      name: agent.name ?? null,
      mode: agent.mode ?? null,
      description: agent.description ?? null,
      role: agent.role ?? null,
      model_provider: agent.modelProvider ?? null,
      model_id: agent.modelId ?? null,
      model_variant: agent.modelVariant ?? null,
      steps: agent.steps ?? null,
      permissions: agent.permissions ?? [],
      source: agent.source ?? null,
    }));

    if (agentPayload.length > 0) {
      await this.query(
        `INSERT INTO factory_agent_catalog (
           agent_id, name, mode, description, role,
           model_provider, model_id, model_variant, steps, permissions,
           source, last_seen_at, updated_at
         )
         SELECT agent_id, name, mode, description, role,
                model_provider, model_id, model_variant, steps, permissions,
                source, now(), now()
         FROM jsonb_to_recordset($1::jsonb) AS x(
           agent_id text, name text, mode text, description text, role text,
           model_provider text, model_id text, model_variant text, steps integer,
           permissions jsonb, source text
         )
         ON CONFLICT (agent_id) DO UPDATE SET
           name = EXCLUDED.name,
           mode = EXCLUDED.mode,
           description = EXCLUDED.description,
           role = EXCLUDED.role,
           model_provider = EXCLUDED.model_provider,
           model_id = EXCLUDED.model_id,
           model_variant = EXCLUDED.model_variant,
           steps = EXCLUDED.steps,
           permissions = EXCLUDED.permissions,
           source = EXCLUDED.source,
           last_seen_at = now(),
           updated_at = now()`,
        [JSON.stringify(agentPayload)],
      );
    }

    return { models: modelPayload.length, agents: agentPayload.length };
  }

  async listModels(filter: ModelFilter = {}): Promise<ModelRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };

    if (filter.providerId) add("provider_id = ?", filter.providerId);
    if (filter.family) add("family = ?", filter.family);
    if (filter.status) add("status = ?", filter.status);
    if (typeof filter.authorized === "boolean") add("authorized = ?", filter.authorized);
    if (typeof filter.prohibited === "boolean") add("prohibited = ?", filter.prohibited);
    if (typeof filter.enabled === "boolean") add("enabled = ?", filter.enabled);
    if (filter.search) {
      const value = `%${filter.search}%`;
      params.push(value, value, value);
      conditions.push(
        `(model_id ILIKE $${params.length - 2} OR name ILIKE $${params.length - 1} OR family ILIKE $${params.length})`,
      );
    }

    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2_000);
    params.push(limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.query<ModelRow>(
      `SELECT * FROM factory_models ${where}
       ORDER BY provider_id, model_id
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapModel);
  }

  async getModel(providerId: string, modelId: string): Promise<ModelRecord | null> {
    const result = await this.query<ModelRow>(
      `SELECT * FROM factory_models WHERE provider_id = $1 AND model_id = $2`,
      [providerId, modelId],
    );
    return result.rows[0] ? mapModel(result.rows[0]) : null;
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.query<AgentRow>(
      `SELECT * FROM factory_agent_catalog ORDER BY agent_id`,
    );
    return result.rows.map(mapAgent);
  }

  async listProfiles(): Promise<ExecutionProfile[]> {
    const result = await this.query<ProfileRow>(
      `SELECT * FROM factory_execution_profiles ORDER BY is_default DESC, name`,
    );
    return result.rows.map(mapProfile);
  }

  async getProfile(id: string): Promise<ExecutionProfileWithAssignments | null> {
    const result = await this.query<ProfileRow>(
      `SELECT * FROM factory_execution_profiles WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const assignments = await this.listAssignments(id);
    return { ...mapProfile(row), assignments };
  }

  async getDefaultProfile(): Promise<ExecutionProfileWithAssignments | null> {
    const result = await this.query<ProfileRow>(
      `SELECT * FROM factory_execution_profiles WHERE is_default LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    const assignments = await this.listAssignments(row.id);
    return { ...mapProfile(row), assignments };
  }

  async listAssignments(profileId: string): Promise<ProfileAssignmentRecord[]> {
    const result = await this.query<AssignmentRow>(
      `SELECT * FROM factory_profile_assignments
       WHERE profile_id = $1
       ORDER BY priority, agent_id`,
      [profileId],
    );
    return result.rows.map(mapAssignment);
  }

  async upsertProfile(input: ProfileInput): Promise<ExecutionProfileWithAssignments> {
    let id = input.id ?? null;
    if (id) {
      const result = await this.query<ProfileRow>(
        `UPDATE factory_execution_profiles
         SET name = $2, description = $3, mode = $4, policy = $5, updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          input.name,
          input.description ?? null,
          input.mode ?? "hybrid",
          JSON.stringify(input.policy ?? {}),
        ],
      );
      if (!result.rows[0]) throw new Error("El perfil no existe.");
    } else {
      const result = await this.query<ProfileRow>(
        `INSERT INTO factory_execution_profiles (name, description, mode, policy)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           mode = EXCLUDED.mode,
           policy = EXCLUDED.policy,
           updated_at = now()
         RETURNING *`,
        [
          input.name,
          input.description ?? null,
          input.mode ?? "hybrid",
          JSON.stringify(input.policy ?? {}),
        ],
      );
      id = result.rows[0]!.id;
    }

    if (input.isDefault) {
      await this.query(
        `UPDATE factory_execution_profiles SET is_default = false
         WHERE is_default AND id <> $1`,
        [id],
      );
      await this.query(
        `UPDATE factory_execution_profiles SET is_default = true, updated_at = now()
         WHERE id = $1`,
        [id],
      );
    }

    await this.query(`DELETE FROM factory_profile_assignments WHERE profile_id = $1`, [id]);
    if (input.assignments.length > 0) {
      const payload = input.assignments.map((assignment) => ({
        agent_id: assignment.agentId,
        provider_id: assignment.providerId,
        model_id: assignment.modelId,
        variant: assignment.variant ?? null,
        locked: assignment.locked ?? true,
        max_cost_usd: assignment.maxCostUsd ?? null,
        max_tokens: assignment.maxTokens ?? null,
        priority: assignment.priority ?? 0,
      }));
      await this.query(
        `INSERT INTO factory_profile_assignments (
           profile_id, agent_id, provider_id, model_id, variant, locked,
           max_cost_usd, max_tokens, priority
         )
         SELECT $1, agent_id, provider_id, model_id, variant, locked,
                max_cost_usd, max_tokens, priority
         FROM jsonb_to_recordset($2::jsonb) AS x(
           agent_id text, provider_id text, model_id text, variant text,
           locked boolean, max_cost_usd numeric, max_tokens integer, priority integer
         )
         ON CONFLICT (profile_id, agent_id) DO UPDATE SET
           provider_id = EXCLUDED.provider_id,
           model_id = EXCLUDED.model_id,
           variant = EXCLUDED.variant,
           locked = EXCLUDED.locked,
           max_cost_usd = EXCLUDED.max_cost_usd,
           max_tokens = EXCLUDED.max_tokens,
           priority = EXCLUDED.priority,
           updated_at = now()`,
        [id, JSON.stringify(payload)],
      );
    }

    return (await this.getProfile(id!))!;
  }

  async deleteProfile(id: string): Promise<boolean> {
    const result = await this.query(
      `DELETE FROM factory_execution_profiles WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setDefaultProfile(id: string): Promise<void> {
    await this.query(
      `UPDATE factory_execution_profiles SET is_default = false
       WHERE is_default AND id <> $1`,
      [id],
    );
    await this.query(
      `UPDATE factory_execution_profiles SET is_default = true, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async setAppliedProfile(location: string, profileId: string): Promise<void> {
    await this.query(
      `INSERT INTO factory_meta (key, value, updated_at)
       VALUES ($1, jsonb_build_object('profile_id', $2::text, 'applied_at', now()), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`applied_profile:${location}`, profileId],
    );
  }

  async getAppliedProfile(location: string): Promise<string | null> {
    const result = await this.query<{ value: unknown }>(
      `SELECT value FROM factory_meta WHERE key = $1`,
      [`applied_profile:${location}`],
    );
    const value = result.rows[0]?.value as { profile_id?: string } | undefined;
    return value?.profile_id ?? null;
  }

  async ensureDefaultProfile(): Promise<ExecutionProfileWithAssignments | null> {
    const current = await this.getDefaultProfile();
    if (current) {
      if (current.assignments.length > 0) return current;
      const seeded = await this.seedAssignments(current.id);
      return { ...current, assignments: seeded };
    }
    const created = await this.query<ProfileRow>(
      `INSERT INTO factory_execution_profiles (name, description, mode, is_default, policy)
       VALUES ('Actual', 'Modelos configurados actualmente en OpenCode', 'hybrid', true, '{}'::jsonb)
       ON CONFLICT (name) DO UPDATE SET is_default = true, updated_at = now()
       RETURNING *`,
    );
    const profile = mapProfile(created.rows[0]!);
    const assignments = await this.seedAssignments(profile.id);
    return { ...profile, assignments };
  }

  private async seedAssignments(profileId: string): Promise<ProfileAssignmentRecord[]> {
    await this.query(
      `INSERT INTO factory_profile_assignments (
         profile_id, agent_id, provider_id, model_id, variant, locked
       )
       SELECT $1, agent_id, model_provider, model_id, model_variant, true
       FROM factory_agent_catalog
       WHERE model_provider IS NOT NULL AND model_id IS NOT NULL
       ON CONFLICT (profile_id, agent_id) DO NOTHING`,
      [profileId],
    );
    return this.listAssignments(profileId);
  }

  async audit(action: string, target: string | null, detail: Record<string, unknown>): Promise<void> {
    await this.query(
      `INSERT INTO factory_audit_events (actor, action, target, detail)
       VALUES ('factory-ui', $1, $2, $3)`,
      [action, target, JSON.stringify(detail)],
    );
  }

  async logExecution(input: ExecutionLogInput): Promise<void> {
    await this.query(
      `INSERT INTO factory_execution_log (
         profile_id, session_id, agent_id, provider_id, model_id, role,
         task_id, plan_id, tokens_input, tokens_output, tokens_reasoning,
         tokens_cache_read, tokens_cache_write, cost_usd, cost_source,
         status, error, started_at, finished_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               COALESCE($18::timestamptz, now()), $19::timestamptz)`,
      [
        input.profileId ?? null,
        input.sessionId ?? null,
        input.agentId ?? null,
        input.providerId ?? null,
        input.modelId ?? null,
        input.role ?? null,
        input.taskId ?? null,
        input.planId ?? null,
        input.tokensInput ?? 0,
        input.tokensOutput ?? 0,
        input.tokensReasoning ?? 0,
        input.tokensCacheRead ?? 0,
        input.tokensCacheWrite ?? 0,
        input.costUsd ?? null,
        input.costSource ?? null,
        input.status ?? null,
        input.error ?? null,
        input.startedAt ?? null,
        input.finishedAt ?? null,
      ],
    );
  }

  async listMemories(filter: MemoryFilter = {}): Promise<MemoryRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.scope) add("scope = ?", filter.scope);
    if (filter.projectId) add("project_id = ?", filter.projectId);
    if (filter.kind) add("kind = ?", filter.kind);
    if (typeof filter.pinned === "boolean") add("pinned = ?", filter.pinned);
    if (filter.search) {
      const value = `%${filter.search}%`;
      params.push(value, value);
      conditions.push(
        `(content ILIKE $${params.length - 1} OR title ILIKE $${params.length})`,
      );
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    params.push(limit, offset);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.query<Record<string, unknown>>(
      `SELECT id, scope, project_id, kind, title, content, tags, importance,
              pinned, source_session, created_at, updated_at, last_used_at, use_count
       FROM memories ${where}
       ORDER BY pinned DESC, importance DESC, updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows.map(mapMemoryRow);
  }

  async memoryStats(): Promise<MemoryStats> {
    const [scopes, kinds, size, dates] = await Promise.all([
      this.query<{ scope: string; count: string }>(
        `SELECT scope, count(*)::text AS count FROM memories GROUP BY scope`,
      ),
      this.query<{ kind: string; count: string }>(
        `SELECT kind, count(*)::text AS count FROM memories GROUP BY kind`,
      ),
      this.query<{ size: string }>(
        `SELECT pg_size_pretty(pg_total_relation_size('memories')) AS size`,
      ),
      this.query<{ oldest: Date | string | null; newest: Date | string | null; total: string }>(
        `SELECT min(created_at) AS oldest, max(updated_at) AS newest, count(*)::text AS total FROM memories`,
      ),
    ]);
    const byScope: Record<string, number> = {};
    for (const row of scopes.rows) byScope[row.scope] = Number(row.count);
    const byKind: Record<string, number> = {};
    for (const row of kinds.rows) byKind[row.kind] = Number(row.count);
    const total = Number(dates.rows[0]?.total ?? 0);
    return {
      total,
      byScope,
      byKind,
      size: size.rows[0]?.size ?? null,
      oldest: dates.rows[0]?.oldest ? ISO(dates.rows[0].oldest) : null,
      newest: dates.rows[0]?.newest ? ISO(dates.rows[0].newest) : null,
    };
  }

  async updateMemory(
    id: string,
    input: { title?: string | null; tags?: string[]; importance?: number; pinned?: boolean },
  ): Promise<MemoryRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      sets.push(sql.replace("?", `$${params.length}`));
    };
    if (input.title !== undefined) add("title = ?", input.title);
    if (input.tags !== undefined) add("tags = ?", input.tags);
    if (input.importance !== undefined) add("importance = ?", Math.round(input.importance));
    if (input.pinned !== undefined) add("pinned = ?", input.pinned);
    if (sets.length === 0) return null;
    params.push(id);
    const result = await this.query<Record<string, unknown>>(
      `UPDATE memories SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${params.length}
       RETURNING id, scope, project_id, kind, title, content, tags, importance,
                 pinned, source_session, created_at, updated_at, last_used_at, use_count`,
      params,
    );
    return result.rows[0] ? mapMemoryRow(result.rows[0]) : null;
  }

  async deleteMemories(ids: string[]): Promise<number> {
    const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (valid.length === 0) return 0;
    const result = await this.query(
      `DELETE FROM memories WHERE id = ANY($1::uuid[])`,
      [valid],
    );
    return result.rowCount ?? 0;
  }
}

export function createMamStore(query: QueryFn): MamStore {
  return new MamStore(query);
}
