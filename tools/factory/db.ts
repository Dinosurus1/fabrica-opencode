/**
 * Capa de datos de la fábrica.
 *
 * Qué hace: crea/consulta el perfil exacto de cada proyecto y el tablero de tareas
 * en la MISMA base PostgreSQL/pgvector que usa opencode-memory. No toca la tabla
 * `memories` ni el esquema de memoria: solo añade `factory_projects` y `tasks`.
 *
 * Qué accede: PostgreSQL en la URL recibida por el plugin (por defecto, la misma
 * base local de opencode-memory). No lee archivos, no ejecuta comandos y no
 * registra la cadena de conexión ni secretos.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount?: number | null;
}

export type QueryFn = <T = Record<string, unknown>>(
  sql: string,
  params?: readonly unknown[],
) => Promise<QueryResult<T>>;

export interface ProjectRef {
  projectId: string;
  directory: string;
  name: string;
}

export interface FactoryProfile {
  projectId: string;
  name: string;
  path: string;
  stack: Record<string, unknown>;
  commands: Record<string, string>;
  conventions: Record<string, unknown>;
  quality: Record<string, unknown>;
  baseline: Record<string, unknown>;
  baselineAt: string | null;
  notes: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProfileInput {
  projectId: string;
  name: string;
  path: string;
  stack: Record<string, unknown>;
  commands: Record<string, string>;
  conventions: Record<string, unknown>;
  quality: Record<string, unknown>;
  notes: string | null;
  verifiedAt: string | null;
}

export type TaskStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";

export const TASK_STATUSES: TaskStatus[] = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

export interface FactoryTask {
  id: string;
  projectId: string;
  projectPath: string | null;
  title: string;
  acceptanceCriteria: string;
  status: TaskStatus;
  result: string | null;
  closureReport: Record<string, unknown> | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  projectId: string;
  projectPath: string | null;
  title: string;
  acceptanceCriteria: string;
  status: TaskStatus;
  result: string | null;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  result?: string | null;
  acceptanceCriteria?: string;
}

interface ProfileRow {
  project_id: string;
  name: string;
  path: string;
  stack: unknown;
  commands: unknown;
  conventions: unknown;
  quality: unknown;
  baseline: unknown;
  baseline_at: Date | string | null;
  notes: string | null;
  verified_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TaskRow {
  id: string;
  project_id: string;
  project_path: string | null;
  title: string;
  acceptance_criteria: string;
  status: TaskStatus;
  result: string | null;
  closure_report: unknown;
  closed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface GateRun {
  id: string;
  projectId: string;
  taskId: string | null;
  iteration: number;
  mode: "check" | "baseline";
  status: "pass" | "fail" | "incomplete" | "error";
  gates: unknown[];
  summary: string | null;
  blockingFailures: unknown[];
  warnings: unknown[];
  gitBranch: string | null;
  gitCommit: string | null;
  createdAt: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ReviewUsage {
  sessionId: string | null;
  tokens: TokenUsage;
  costUsd: number;
  costSource: "provider" | "catalog" | "unknown";
  costBasis: string | null;
}

export interface ReviewRun {
  id: string;
  projectId: string;
  taskId: string;
  role: "security" | "code" | "qa";
  model: string;
  verdict: "approved" | "changes_required";
  findings: unknown[];
  openBlocking: number;
  summary: string | null;
  gateRunId: string | null;
  iteration: number;
  usage: ReviewUsage;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  scope: string;
  projectId: string;
  kind: string;
  title: string | null;
  content: string;
  updatedAt: string;
}

export interface CreateGateRunInput {
  projectId: string;
  taskId: string | null;
  iteration: number;
  mode: "check" | "baseline";
  status: "pass" | "fail" | "incomplete" | "error";
  gates: unknown[];
  summary: string | null;
  blockingFailures: unknown[];
  warnings: unknown[];
  gitBranch: string | null;
  gitCommit: string | null;
}

export interface CreateReviewRunInput {
  projectId: string;
  taskId: string;
  role: "security" | "code" | "qa";
  model: string;
  verdict: "approved" | "changes_required";
  findings: unknown[];
  openBlocking: number;
  summary: string | null;
  gateRunId: string | null;
  iteration: number;
  usage: ReviewUsage;
}

interface GateRunRow {
  id: string;
  project_id: string;
  task_id: string | null;
  iteration: number;
  mode: "check" | "baseline";
  status: "pass" | "fail" | "incomplete" | "error";
  gates: unknown;
  summary: string | null;
  blocking_failures: unknown;
  warnings: unknown;
  git_branch: string | null;
  git_commit: string | null;
  created_at: Date | string;
}

interface ReviewRunRow {
  id: string;
  project_id: string;
  task_id: string;
  role: "security" | "code" | "qa";
  model: string;
  verdict: "approved" | "changes_required";
  findings: unknown;
  open_blocking: number;
  summary: string | null;
  gate_run_id: string | null;
  iteration: number;
  session_id: string | null;
  tokens_input: string | number;
  tokens_output: string | number;
  tokens_reasoning: string | number;
  tokens_cache_read: string | number;
  tokens_cache_write: string | number;
  cost_usd: string | number;
  cost_source: "provider" | "catalog" | "unknown";
  cost_basis: string | null;
  created_at: Date | string;
}

interface MemoryRow {
  id: string;
  scope: string;
  project_id: string;
  kind: string;
  title: string | null;
  content: string;
  updated_at: Date | string;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asNullableObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const object = asObject<Record<string, unknown>>(value, {});
  return Object.keys(object).length > 0 ? object : null;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asObject<T extends Record<string, unknown>>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
    } catch {
      return fallback;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  return fallback;
}

function asCommands(value: unknown): Record<string, string> {
  const source = asObject<Record<string, unknown>>(value, {});
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw === "string" && raw.trim()) result[key] = raw.trim();
  }
  return result;
}

function mapProfile(row: ProfileRow): FactoryProfile {
  return {
    projectId: row.project_id,
    name: row.name,
    path: row.path,
    stack: asObject(row.stack, {}),
    commands: asCommands(row.commands),
    conventions: asObject(row.conventions, {}),
    quality: asObject(row.quality, {}),
    baseline: asObject(row.baseline, {}),
    baselineAt: iso(row.baseline_at),
    notes: row.notes,
    verifiedAt: iso(row.verified_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

function mapTask(row: TaskRow): FactoryTask {
  return {
    id: row.id,
    projectId: row.project_id,
    projectPath: row.project_path,
    title: row.title,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status,
    result: row.result,
    closureReport: asNullableObject(row.closure_report),
    closedAt: iso(row.closed_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

function mapGateRun(row: GateRunRow): GateRun {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    iteration: Number(row.iteration),
    mode: row.mode,
    status: row.status,
    gates: asArray(row.gates),
    summary: row.summary,
    blockingFailures: asArray(row.blocking_failures),
    warnings: asArray(row.warnings),
    gitBranch: row.git_branch,
    gitCommit: row.git_commit,
    createdAt: iso(row.created_at) ?? "",
  };
}

function mapReviewRun(row: ReviewRunRow): ReviewRun {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    role: row.role,
    model: row.model,
    verdict: row.verdict,
    findings: asArray(row.findings),
    openBlocking: Number(row.open_blocking),
    summary: row.summary,
    gateRunId: row.gate_run_id,
    iteration: Number(row.iteration),
    usage: {
      sessionId: row.session_id,
      tokens: {
        input: Number(row.tokens_input),
        output: Number(row.tokens_output),
        reasoning: Number(row.tokens_reasoning),
        cacheRead: Number(row.tokens_cache_read),
        cacheWrite: Number(row.tokens_cache_write),
      },
      costUsd: Number(row.cost_usd),
      costSource: row.cost_source,
      costBasis: row.cost_basis,
    },
    createdAt: iso(row.created_at) ?? "",
  };
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    updatedAt: iso(row.updated_at) ?? "",
  };
}

export function createFactoryDb(query: QueryFn, migrationSql: string | string[]) {
  const migrations = Array.isArray(migrationSql) ? migrationSql : [migrationSql];
  let ready: Promise<void> | null = null;

  const init = (): Promise<void> => {
    if (!ready) {
      ready = (async () => {
        for (const sql of migrations) await query(sql);
      })().catch((error) => {
        // Si falla una migración, permitimos reintentar en la siguiente llamada.
        ready = null;
        throw error;
      });
    }
    return ready;
  };

  async function getProfile(projectId: string): Promise<FactoryProfile | null> {
    await init();
    const result = await query<ProfileRow>(
      `SELECT project_id, name, path, stack, commands, conventions, quality, baseline,
              baseline_at, notes, verified_at, created_at, updated_at
       FROM factory_projects
       WHERE project_id = $1`,
      [projectId],
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async function upsertProfile(input: UpsertProfileInput): Promise<FactoryProfile> {
    await init();
    const result = await query<ProfileRow>(
      `INSERT INTO factory_projects
         (project_id, name, path, stack, commands, conventions, quality, notes, verified_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
       ON CONFLICT (project_id) DO UPDATE SET
         name = EXCLUDED.name,
         path = EXCLUDED.path,
         stack = EXCLUDED.stack,
         commands = EXCLUDED.commands,
         conventions = EXCLUDED.conventions,
         quality = EXCLUDED.quality,
         notes = EXCLUDED.notes,
         verified_at = EXCLUDED.verified_at,
         updated_at = now()
       RETURNING project_id, name, path, stack, commands, conventions, quality,
                 baseline, baseline_at, notes, verified_at, created_at, updated_at`,
      [
        input.projectId,
        input.name,
        input.path,
        JSON.stringify(input.stack),
        JSON.stringify(input.commands),
        JSON.stringify(input.conventions),
        JSON.stringify(input.quality),
        input.notes,
        input.verifiedAt,
      ],
    );
    return mapProfile(result.rows[0]!);
  }

  async function createTask(input: CreateTaskInput): Promise<FactoryTask> {
    await init();
    const result = await query<TaskRow>(
      `INSERT INTO tasks
         (project_id, project_path, title, acceptance_criteria, status, result)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, project_id, project_path, title, acceptance_criteria,
                 status, result, closure_report, closed_at, created_at, updated_at`,
      [
        input.projectId,
        input.projectPath,
        input.title,
        input.acceptanceCriteria,
        input.status,
        input.result,
      ],
    );
    return mapTask(result.rows[0]!);
  }

  async function getTask(projectId: string, id: string): Promise<FactoryTask | null> {
    await init();
    const result = await query<TaskRow>(
      `SELECT id, project_id, project_path, title, acceptance_criteria,
              status, result, closure_report, closed_at, created_at, updated_at
       FROM tasks
       WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async function updateTask(
    projectId: string,
    id: string,
    patch: UpdateTaskInput,
  ): Promise<FactoryTask | null> {
    await init();
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.status !== undefined) {
      values.push(patch.status);
      sets.push(`status = $${values.length}`);
    }
    if (patch.result !== undefined) {
      values.push(patch.result);
      sets.push(`result = $${values.length}`);
    }
    if (patch.acceptanceCriteria !== undefined) {
      values.push(patch.acceptanceCriteria);
      sets.push(`acceptance_criteria = $${values.length}`);
    }

    if (sets.length === 0) return getTask(projectId, id);

    values.push(projectId, id);
    sets.push("updated_at = now()");
    const result = await query<TaskRow>(
      `UPDATE tasks
       SET ${sets.join(", ")}
       WHERE project_id = $${values.length - 1} AND id = $${values.length}
       RETURNING id, project_id, project_path, title, acceptance_criteria,
                 status, result, closure_report, closed_at, created_at, updated_at`,
      values,
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async function health(): Promise<boolean> {
    await init();
    const result = await query<{ ok: number }>("SELECT 1 AS ok");
    return Number(result.rows[0]?.ok) === 1;
  }

  async function tableExists(name: string): Promise<boolean> {
    await init();
    const result = await query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [name]);
    return Boolean(result.rows[0]?.present);
  }

  async function columnExists(table: string, column: string): Promise<boolean> {
    await init();
    const result = await query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS present`,
      [table, column],
    );
    return Boolean(result.rows[0]?.present);
  }

  async function listTasks(
    projectId: string,
    options: { status?: TaskStatus; limit?: number } = {},
  ): Promise<FactoryTask[]> {
    await init();
    const values: unknown[] = [projectId];
    let where = "project_id = $1";
    if (options.status) {
      values.push(options.status);
      where += ` AND status = $${values.length}`;
    }
    values.push(Math.min(Math.max(options.limit ?? 20, 1), 100));
    const result = await query<TaskRow>(
      `SELECT id, project_id, project_path, title, acceptance_criteria,
              status, result, closure_report, closed_at, created_at, updated_at
       FROM tasks
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapTask);
  }

  async function setQuality(projectId: string, quality: Record<string, unknown>): Promise<FactoryProfile | null> {
    await init();
    const result = await query<ProfileRow>(
      `UPDATE factory_projects
       SET quality = $2::jsonb, updated_at = now()
       WHERE project_id = $1
       RETURNING project_id, name, path, stack, commands, conventions, quality,
                 baseline, baseline_at, notes, verified_at, created_at, updated_at`,
      [projectId, JSON.stringify(quality)],
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async function setBaseline(projectId: string, baseline: Record<string, unknown>): Promise<FactoryProfile | null> {
    await init();
    const result = await query<ProfileRow>(
      `UPDATE factory_projects
       SET baseline = $2::jsonb, baseline_at = now(), updated_at = now()
       WHERE project_id = $1
       RETURNING project_id, name, path, stack, commands, conventions, quality,
                 baseline, baseline_at, notes, verified_at, created_at, updated_at`,
      [projectId, JSON.stringify(baseline)],
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async function closeTask(
    projectId: string,
    id: string,
    report: Record<string, unknown>,
    summary: string | null,
  ): Promise<FactoryTask | null> {
    await init();
    const result = await query<TaskRow>(
      `UPDATE tasks
       SET status = 'done',
           result = $3,
           closure_report = $4::jsonb,
           closed_at = now(),
           updated_at = now()
       WHERE project_id = $1 AND id = $2
       RETURNING id, project_id, project_path, title, acceptance_criteria,
                 status, result, closure_report, closed_at, created_at, updated_at`,
      [projectId, id, summary, JSON.stringify(report)],
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async function createGateRun(input: CreateGateRunInput): Promise<GateRun> {
    await init();
    const result = await query<GateRunRow>(
      `INSERT INTO gate_runs
         (project_id, task_id, iteration, mode, status, gates, summary,
          blocking_failures, warnings, git_branch, git_commit)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10, $11)
       RETURNING id, project_id, task_id, iteration, mode, status, gates, summary,
                 blocking_failures, warnings, git_branch, git_commit, created_at`,
      [
        input.projectId,
        input.taskId,
        input.iteration,
        input.mode,
        input.status,
        JSON.stringify(input.gates),
        input.summary,
        JSON.stringify(input.blockingFailures),
        JSON.stringify(input.warnings),
        input.gitBranch,
        input.gitCommit,
      ],
    );
    return mapGateRun(result.rows[0]!);
  }

  async function getGateRun(id: string): Promise<GateRun | null> {
    await init();
    const result = await query<GateRunRow>(
      `SELECT id, project_id, task_id, iteration, mode, status, gates, summary,
              blocking_failures, warnings, git_branch, git_commit, created_at
       FROM gate_runs WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapGateRun(result.rows[0]) : null;
  }

  async function getLatestGateRun(projectId: string, taskId: string): Promise<GateRun | null> {
    await init();
    const result = await query<GateRunRow>(
      `SELECT id, project_id, task_id, iteration, mode, status, gates, summary,
              blocking_failures, warnings, git_branch, git_commit, created_at
       FROM gate_runs
       WHERE project_id = $1 AND task_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId, taskId],
    );
    return result.rows[0] ? mapGateRun(result.rows[0]) : null;
  }

  async function createReviewRun(input: CreateReviewRunInput): Promise<ReviewRun> {
    await init();
    const result = await query<ReviewRunRow>(
      `INSERT INTO review_runs
         (project_id, task_id, role, model, verdict, findings, open_blocking,
          summary, gate_run_id, iteration, session_id, tokens_input, tokens_output,
          tokens_reasoning, tokens_cache_read, tokens_cache_write,
          cost_usd, cost_source, cost_basis)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19)
       RETURNING id, project_id, task_id, role, model, verdict, findings,
                 open_blocking, summary, gate_run_id, iteration, session_id,
                 tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
                 tokens_cache_write, cost_usd, cost_source, cost_basis, created_at`,
      [
        input.projectId,
        input.taskId,
        input.role,
        input.model,
        input.verdict,
        JSON.stringify(input.findings),
        input.openBlocking,
        input.summary,
        input.gateRunId,
        input.iteration,
        input.usage.sessionId,
        input.usage.tokens.input,
        input.usage.tokens.output,
        input.usage.tokens.reasoning,
        input.usage.tokens.cacheRead,
        input.usage.tokens.cacheWrite,
        input.usage.costUsd,
        input.usage.costSource,
        input.usage.costBasis,
      ],
    );
    return mapReviewRun(result.rows[0]!);
  }

  async function getLatestReviews(taskId: string): Promise<ReviewRun[]> {
    await init();
    const result = await query<ReviewRunRow>(
      `SELECT DISTINCT ON (role)
              id, project_id, task_id, role, model, verdict, findings,
              open_blocking, summary, gate_run_id, iteration, session_id,
              tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
              tokens_cache_write, cost_usd, cost_source, cost_basis, created_at
       FROM review_runs
       WHERE task_id = $1
       ORDER BY role, created_at DESC`,
      [taskId],
    );
    return result.rows.map(mapReviewRun);
  }

  async function getMemory(id: string): Promise<MemoryRecord | null> {
    await init();
    const result = await query<MemoryRow>(
      `SELECT id, scope, project_id, kind, title, content, updated_at
       FROM memories WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapMemory(result.rows[0]) : null;
  }

  async function getMeta(key: string): Promise<unknown | null> {
    await init();
    const result = await query<{ value: unknown }>(
      `SELECT value FROM factory_meta WHERE key = $1`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  return {
    init,
    getProfile,
    upsertProfile,
    setQuality,
    setBaseline,
    createTask,
    getTask,
    updateTask,
    listTasks,
    closeTask,
    createGateRun,
    getGateRun,
    getLatestGateRun,
    createReviewRun,
    getLatestReviews,
    getMemory,
    getMeta,
    health,
    tableExists,
    columnExists,
  };
}

export type FactoryDb = ReturnType<typeof createFactoryDb>;
