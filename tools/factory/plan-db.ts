/**
 * Persistencia del plan por fases.
 *
 * Qué hace: lee/escribe `plans`, `plan_tasks`, `plan_reviews`,
 * `plan_validations`, `subtask_runs` y `phase_closures` en la misma base de la
 * fábrica. No ejecuta comandos ni toca archivos.
 */

import type { QueryFn } from "./db.js";

export type PlanStatus =
  | "draft"
  | "review_pending"
  | "validated"
  | "approved"
  | "executing"
  | "paused"
  | "completed"
  | "cancelled";

export type PlanTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "review"
  | "blocked"
  | "merged"
  | "done"
  | "failed"
  | "escalated"
  | "cancelled";

export type Autonomy = "supervised" | "semi_autonomous" | "autonomous";

export interface PlanRecord {
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  status: PlanStatus;
  autonomy: Autonomy;
  maxConcurrency: number;
  reviewRound: number;
  reviewFindings: unknown[];
  reviewExhausted: boolean;
  residualFindings: unknown[];
  approvalWaiver: Record<string, unknown>;
  validation: Record<string, unknown>;
  sourceDocuments: unknown[];
  baseline: Record<string, unknown>;
  metadata: Record<string, unknown>;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanTaskRecord {
  id: string;
  planId: string;
  taskId: string | null;
  phase: number;
  phaseName: string | null;
  orderIndex: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  difficulty: "easy" | "medium" | "hard";
  difficultyReason: string;
  assignee: "orchestrator" | "implementer";
  model: string;
  filesOwned: string[];
  riskFlags: string[];
  parallelizable: boolean;
  dependsOn: string[];
  worktree: string | null;
  branch: string | null;
  status: PlanTaskStatus;
  attempts: number;
  sessionId: string | null;
  reviewRoute: Record<string, string>;
  result: Record<string, unknown>;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanReviewRecord {
  id: string;
  planId: string;
  round: number;
  model: string;
  verdict: "approved" | "changes_required";
  findings: unknown[];
  blockingCount: number;
  advisoryCount: number;
  newFindings: number;
  resolvedFindings: number;
  summary: string | null;
  sessionId: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  costSource: "provider" | "catalog" | "unknown";
  costBasis: string | null;
  createdAt: string;
}

export interface PlanValidationRecord {
  id: string;
  planId: string;
  status: "pass" | "fail";
  errors: unknown[];
  warnings: unknown[];
  waves: unknown[];
  createdAt: string;
}

export interface SubtaskRunRecord {
  id: string;
  planId: string;
  planTaskId: string;
  taskId: string | null;
  sessionId: string | null;
  worktree: string | null;
  branch: string | null;
  model: string;
  status: "running" | "done" | "failed" | "escalated" | "cancelled";
  summary: string | null;
  result: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  costSource: "provider" | "catalog" | "unknown";
  costBasis: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface PhaseClosureRecord {
  id: string;
  planId: string;
  phase: number;
  status: "closed" | "blocked" | "cancelled";
  gateRunId: string | null;
  codeReviewId: string | null;
  securityReviewId: string | null;
  report: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  costSource: "provider" | "catalog" | "unknown";
  createdAt: string;
}

interface PlanRow {
  id: string;
  project_id: string;
  project_path: string;
  title: string;
  status: PlanStatus;
  autonomy: Autonomy;
  max_concurrency: number;
  review_round: number;
  review_findings: unknown;
  review_exhausted: boolean;
  residual_findings: unknown;
  approval_waiver: unknown;
  validation: unknown;
  source_documents: unknown;
  baseline: unknown;
  metadata: unknown;
  approved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PlanTaskRow {
  id: string;
  plan_id: string;
  task_id: string | null;
  phase: number;
  phase_name: string | null;
  order_index: number;
  title: string;
  description: string;
  acceptance_criteria: string;
  difficulty: "easy" | "medium" | "hard";
  difficulty_reason: string;
  assignee: "orchestrator" | "implementer";
  model: string;
  files_owned: unknown;
  risk_flags: unknown;
  parallelizable: boolean;
  depends_on: unknown;
  worktree: string | null;
  branch: string | null;
  status: PlanTaskStatus;
  attempts: number;
  session_id: string | null;
  review_route: unknown;
  result: unknown;
  last_error: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
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

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

function mapPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectPath: row.project_path,
    title: row.title,
    status: row.status,
    autonomy: row.autonomy,
    maxConcurrency: Number(row.max_concurrency),
    reviewRound: Number(row.review_round),
    reviewFindings: asArray(row.review_findings),
    reviewExhausted: Boolean(row.review_exhausted),
    residualFindings: asArray(row.residual_findings),
    approvalWaiver: asObject(row.approval_waiver),
    validation: asObject(row.validation),
    sourceDocuments: asArray(row.source_documents),
    baseline: asObject(row.baseline),
    metadata: asObject(row.metadata),
    approvedAt: iso(row.approved_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

function mapPlanTask(row: PlanTaskRow): PlanTaskRecord {
  return {
    id: row.id,
    planId: row.plan_id,
    taskId: row.task_id,
    phase: Number(row.phase),
    phaseName: row.phase_name,
    orderIndex: Number(row.order_index),
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    difficulty: row.difficulty,
    difficultyReason: row.difficulty_reason,
    assignee: row.assignee,
    model: row.model,
    filesOwned: asStringArray(row.files_owned),
    riskFlags: asStringArray(row.risk_flags),
    parallelizable: Boolean(row.parallelizable),
    dependsOn: asStringArray(row.depends_on),
    worktree: row.worktree,
    branch: row.branch,
    status: row.status,
    attempts: Number(row.attempts),
    sessionId: row.session_id,
    reviewRoute: Object.fromEntries(
      Object.entries(asObject(row.review_route)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    result: asObject(row.result),
    lastError: row.last_error,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

function mapPlanReview(row: Record<string, unknown>): PlanReviewRecord {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    round: Number(row.round),
    model: String(row.model),
    verdict: row.verdict === "approved" ? "approved" : "changes_required",
    findings: asArray(row.findings),
    blockingCount: num(row.blocking_count),
    advisoryCount: num(row.advisory_count),
    newFindings: num(row.new_findings),
    resolvedFindings: num(row.resolved_findings),
    summary: typeof row.summary === "string" ? row.summary : null,
    sessionId: typeof row.session_id === "string" ? row.session_id : null,
    tokensInput: num(row.tokens_input),
    tokensOutput: num(row.tokens_output),
    tokensReasoning: num(row.tokens_reasoning),
    tokensCacheRead: num(row.tokens_cache_read),
    tokensCacheWrite: num(row.tokens_cache_write),
    costUsd: num(row.cost_usd),
    costSource: row.cost_source === "provider" || row.cost_source === "catalog" ? row.cost_source : "unknown",
    costBasis: typeof row.cost_basis === "string" ? row.cost_basis : null,
    createdAt: iso(row.created_at as Date | string | null) ?? "",
  };
}

function mapSubtaskRun(row: Record<string, unknown>): SubtaskRunRecord {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    planTaskId: String(row.plan_task_id),
    taskId: typeof row.task_id === "string" ? row.task_id : null,
    sessionId: typeof row.session_id === "string" ? row.session_id : null,
    worktree: typeof row.worktree === "string" ? row.worktree : null,
    branch: typeof row.branch === "string" ? row.branch : null,
    model: String(row.model),
    status: ["running", "done", "failed", "escalated", "cancelled"].includes(String(row.status))
      ? (row.status as SubtaskRunRecord["status"])
      : "failed",
    summary: typeof row.summary === "string" ? row.summary : null,
    result: asObject(row.result),
    tokensInput: num(row.tokens_input),
    tokensOutput: num(row.tokens_output),
    tokensReasoning: num(row.tokens_reasoning),
    tokensCacheRead: num(row.tokens_cache_read),
    tokensCacheWrite: num(row.tokens_cache_write),
    costUsd: num(row.cost_usd),
    costSource: row.cost_source === "provider" || row.cost_source === "catalog" ? row.cost_source : "unknown",
    costBasis: typeof row.cost_basis === "string" ? row.cost_basis : null,
    startedAt: iso(row.started_at as Date | string | null) ?? "",
    finishedAt: iso(row.finished_at as Date | string | null),
  };
}

function mapPhaseClosure(row: Record<string, unknown>): PhaseClosureRecord {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    phase: Number(row.phase),
    status: ["closed", "blocked", "cancelled"].includes(String(row.status))
      ? (row.status as PhaseClosureRecord["status"])
      : "blocked",
    gateRunId: typeof row.gate_run_id === "string" ? row.gate_run_id : null,
    codeReviewId: typeof row.code_review_id === "string" ? row.code_review_id : null,
    securityReviewId: typeof row.security_review_id === "string" ? row.security_review_id : null,
    report: asObject(row.report),
    tokensInput: num(row.tokens_input),
    tokensOutput: num(row.tokens_output),
    tokensReasoning: num(row.tokens_reasoning),
    tokensCacheRead: num(row.tokens_cache_read),
    tokensCacheWrite: num(row.tokens_cache_write),
    costUsd: num(row.cost_usd),
    costSource: row.cost_source === "provider" || row.cost_source === "catalog" ? row.cost_source : "unknown",
    createdAt: iso(row.created_at as Date | string | null) ?? "",
  };
}

export interface CreatePlanInput {
  projectId: string;
  projectPath: string;
  title: string;
  autonomy: Autonomy;
  maxConcurrency: number;
  sourceDocuments: unknown[];
  metadata: Record<string, unknown>;
}

export interface CreatePlanTaskInput {
  id?: string;
  planId: string;
  phase: number;
  phaseName: string | null;
  orderIndex: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  difficulty: "easy" | "medium" | "hard";
  difficultyReason: string;
  assignee: "orchestrator" | "implementer";
  model: string;
  filesOwned: string[];
  riskFlags: string[];
  parallelizable: boolean;
  dependsOn: string[];
}

export interface UpdatePlanInput {
  title?: string;
  status?: PlanStatus;
  autonomy?: Autonomy;
  maxConcurrency?: number;
  reviewRound?: number;
  reviewFindings?: unknown[];
  reviewExhausted?: boolean;
  residualFindings?: unknown[];
  approvalWaiver?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  approvedAt?: string | null;
}

export interface UpdatePlanTaskInput {
  taskId?: string | null;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  difficulty?: "easy" | "medium" | "hard";
  difficultyReason?: string;
  phase?: number;
  phaseName?: string | null;
  orderIndex?: number;
  status?: PlanTaskStatus;
  worktree?: string | null;
  branch?: string | null;
  attempts?: number;
  sessionId?: string | null;
  reviewRoute?: Record<string, string>;
  result?: Record<string, unknown>;
  lastError?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  assignee?: "orchestrator" | "implementer";
  model?: string;
  filesOwned?: string[];
  riskFlags?: string[];
  parallelizable?: boolean;
  dependsOn?: string[];
}

const PLAN_COLUMNS = `id, project_id, project_path, title, status, autonomy, max_concurrency,
  review_round, review_findings, review_exhausted, residual_findings, approval_waiver,
  validation, source_documents, baseline, metadata, approved_at, created_at, updated_at`;

const PLAN_TASK_COLUMNS = `id, plan_id, task_id, phase, phase_name, order_index, title, description,
  acceptance_criteria, difficulty, difficulty_reason, assignee, model, files_owned, risk_flags,
  parallelizable, depends_on, worktree, branch, status, attempts, session_id, review_route,
  result, last_error, started_at, finished_at, created_at, updated_at`;

export function createPlanStore(query: QueryFn, init: () => Promise<void>) {
  async function createPlan(input: CreatePlanInput): Promise<PlanRecord> {
    await init();
    const result = await query<PlanRow>(
      `INSERT INTO plans
         (project_id, project_path, title, autonomy, max_concurrency, source_documents, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING ${PLAN_COLUMNS}`,
      [
        input.projectId,
        input.projectPath,
        input.title,
        input.autonomy,
        input.maxConcurrency,
        JSON.stringify(input.sourceDocuments),
        JSON.stringify(input.metadata),
      ],
    );
    return mapPlan(result.rows[0]!);
  }

  async function getPlan(projectId: string, planId: string): Promise<PlanRecord | null> {
    await init();
    const result = await query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE project_id = $1 AND id = $2`,
      [projectId, planId],
    );
    return result.rows[0] ? mapPlan(result.rows[0]) : null;
  }

  async function listPlans(projectId: string, limit = 20): Promise<PlanRecord[]> {
    await init();
    const result = await query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [projectId, Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows.map(mapPlan);
  }

  async function updatePlan(projectId: string, planId: string, patch: UpdatePlanInput): Promise<PlanRecord | null> {
    await init();
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      values.push(value);
      sets.push(`${sql} = $${values.length}`);
    };
    if (patch.title !== undefined) push("title", patch.title);
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.autonomy !== undefined) push("autonomy", patch.autonomy);
    if (patch.maxConcurrency !== undefined) push("max_concurrency", patch.maxConcurrency);
    if (patch.reviewRound !== undefined) push("review_round", patch.reviewRound);
    if (patch.reviewFindings !== undefined) push("review_findings", JSON.stringify(patch.reviewFindings));
    if (patch.reviewExhausted !== undefined) push("review_exhausted", patch.reviewExhausted);
    if (patch.residualFindings !== undefined) push("residual_findings", JSON.stringify(patch.residualFindings));
    if (patch.approvalWaiver !== undefined) push("approval_waiver", JSON.stringify(patch.approvalWaiver));
    if (patch.validation !== undefined) push("validation", JSON.stringify(patch.validation));
    if (patch.metadata !== undefined) push("metadata", JSON.stringify(patch.metadata));
    if (patch.approvedAt !== undefined) push("approved_at", patch.approvedAt);
    if (sets.length === 0) return getPlan(projectId, planId);
    sets.push("updated_at = now()");
    values.push(projectId, planId);
    const result = await query<PlanRow>(
      `UPDATE plans SET ${sets.join(", ")}
       WHERE project_id = $${values.length - 1} AND id = $${values.length}
       RETURNING ${PLAN_COLUMNS}`,
      values,
    );
    return result.rows[0] ? mapPlan(result.rows[0]) : null;
  }

  async function createPlanTask(input: CreatePlanTaskInput): Promise<PlanTaskRecord> {
    await init();
    const result = await query<PlanTaskRow>(
      `INSERT INTO plan_tasks
         (id, plan_id, phase, phase_name, order_index, title, description, acceptance_criteria,
          difficulty, difficulty_reason, assignee, model, files_owned, risk_flags,
          parallelizable, depends_on)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13::text[], $14::text[], $15, $16::uuid[])
       RETURNING ${PLAN_TASK_COLUMNS}`,
      [
        input.id ?? null,
        input.planId,
        input.phase,
        input.phaseName,
        input.orderIndex,
        input.title,
        input.description,
        input.acceptanceCriteria,
        input.difficulty,
        input.difficultyReason,
        input.assignee,
        input.model,
        input.filesOwned,
        input.riskFlags,
        input.parallelizable,
        input.dependsOn,
      ],
    );
    return mapPlanTask(result.rows[0]!);
  }

  async function listPlanTasks(planId: string): Promise<PlanTaskRecord[]> {
    await init();
    const result = await query<PlanTaskRow>(
      `SELECT ${PLAN_TASK_COLUMNS} FROM plan_tasks
       WHERE plan_id = $1
       ORDER BY phase, order_index, created_at`,
      [planId],
    );
    return result.rows.map(mapPlanTask);
  }

  async function getPlanTask(planId: string, planTaskId: string): Promise<PlanTaskRecord | null> {
    await init();
    const result = await query<PlanTaskRow>(
      `SELECT ${PLAN_TASK_COLUMNS} FROM plan_tasks WHERE plan_id = $1 AND id = $2`,
      [planId, planTaskId],
    );
    return result.rows[0] ? mapPlanTask(result.rows[0]) : null;
  }

  async function getPlanTaskByTaskId(taskId: string): Promise<PlanTaskRecord | null> {
    await init();
    const result = await query<PlanTaskRow>(
      `SELECT ${PLAN_TASK_COLUMNS} FROM plan_tasks WHERE task_id = $1 LIMIT 1`,
      [taskId],
    );
    return result.rows[0] ? mapPlanTask(result.rows[0]) : null;
  }

  async function updatePlanTask(
    planId: string,
    planTaskId: string,
    patch: UpdatePlanTaskInput,
  ): Promise<PlanTaskRecord | null> {
    await init();
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      values.push(value);
      sets.push(`${sql} = $${values.length}`);
    };
    if (patch.taskId !== undefined) push("task_id", patch.taskId);
    if (patch.title !== undefined) push("title", patch.title);
    if (patch.description !== undefined) push("description", patch.description);
    if (patch.acceptanceCriteria !== undefined) push("acceptance_criteria", patch.acceptanceCriteria);
    if (patch.difficulty !== undefined) push("difficulty", patch.difficulty);
    if (patch.difficultyReason !== undefined) push("difficulty_reason", patch.difficultyReason);
    if (patch.phase !== undefined) push("phase", patch.phase);
    if (patch.phaseName !== undefined) push("phase_name", patch.phaseName);
    if (patch.orderIndex !== undefined) push("order_index", patch.orderIndex);
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.worktree !== undefined) push("worktree", patch.worktree);
    if (patch.branch !== undefined) push("branch", patch.branch);
    if (patch.attempts !== undefined) push("attempts", patch.attempts);
    if (patch.sessionId !== undefined) push("session_id", patch.sessionId);
    if (patch.reviewRoute !== undefined) push("review_route", JSON.stringify(patch.reviewRoute));
    if (patch.result !== undefined) push("result", JSON.stringify(patch.result));
    if (patch.lastError !== undefined) push("last_error", patch.lastError);
    if (patch.startedAt !== undefined) push("started_at", patch.startedAt);
    if (patch.finishedAt !== undefined) push("finished_at", patch.finishedAt);
    if (patch.assignee !== undefined) push("assignee", patch.assignee);
    if (patch.model !== undefined) push("model", patch.model);
    if (patch.filesOwned !== undefined) push("files_owned", patch.filesOwned);
    if (patch.riskFlags !== undefined) push("risk_flags", patch.riskFlags);
    if (patch.parallelizable !== undefined) push("parallelizable", patch.parallelizable);
    if (patch.dependsOn !== undefined) push("depends_on", patch.dependsOn);
    if (sets.length === 0) return getPlanTask(planId, planTaskId);
    sets.push("updated_at = now()");
    values.push(planId, planTaskId);
    const result = await query<PlanTaskRow>(
      `UPDATE plan_tasks SET ${sets.join(", ")}
       WHERE plan_id = $${values.length - 1} AND id = $${values.length}
       RETURNING ${PLAN_TASK_COLUMNS}`,
      values,
    );
    return result.rows[0] ? mapPlanTask(result.rows[0]) : null;
  }

  async function createPlanReview(input: {
    planId: string;
    round: number;
    model: string;
    verdict: "approved" | "changes_required";
    findings: unknown[];
    blockingCount: number;
    advisoryCount: number;
    newFindings: number;
    resolvedFindings: number;
    summary: string | null;
    sessionId: string | null;
    usage: {
      tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
      costUsd: number;
      costSource: "provider" | "catalog" | "unknown";
      costBasis: string | null;
    };
  }): Promise<PlanReviewRecord> {
    await init();
    const result = await query<Record<string, unknown>>(
      `INSERT INTO plan_reviews
         (plan_id, round, model, verdict, findings, blocking_count, advisory_count,
          new_findings, resolved_findings, summary, session_id,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          cost_usd, cost_source, cost_basis)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        input.planId,
        input.round,
        input.model,
        input.verdict,
        JSON.stringify(input.findings),
        input.blockingCount,
        input.advisoryCount,
        input.newFindings,
        input.resolvedFindings,
        input.summary,
        input.sessionId,
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
    return mapPlanReview(result.rows[0]!);
  }

  async function listPlanReviews(planId: string): Promise<PlanReviewRecord[]> {
    await init();
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM plan_reviews WHERE plan_id = $1 ORDER BY round DESC`,
      [planId],
    );
    return result.rows.map(mapPlanReview);
  }

  async function createPlanValidation(input: {
    planId: string;
    status: "pass" | "fail";
    errors: unknown[];
    warnings: unknown[];
    waves: unknown[];
  }): Promise<PlanValidationRecord> {
    await init();
    const result = await query<Record<string, unknown>>(
      `INSERT INTO plan_validations (plan_id, status, errors, warnings, waves)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
       RETURNING *`,
      [input.planId, input.status, JSON.stringify(input.errors), JSON.stringify(input.warnings), JSON.stringify(input.waves)],
    );
    const row = result.rows[0]!;
    return {
      id: String(row.id),
      planId: String(row.plan_id),
      status: row.status === "pass" ? "pass" : "fail",
      errors: asArray(row.errors),
      warnings: asArray(row.warnings),
      waves: asArray(row.waves),
      createdAt: iso(row.created_at as Date | string | null) ?? "",
    };
  }

  async function listPlanValidations(planId: string): Promise<PlanValidationRecord[]> {
    await init();
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM plan_validations WHERE plan_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [planId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      planId: String(row.plan_id),
      status: row.status === "pass" ? "pass" : "fail",
      errors: asArray(row.errors),
      warnings: asArray(row.warnings),
      waves: asArray(row.waves),
      createdAt: iso(row.created_at as Date | string | null) ?? "",
    }));
  }

  async function createSubtaskRun(input: {
    planId: string;
    planTaskId: string;
    taskId: string | null;
    sessionId: string | null;
    worktree: string | null;
    branch: string | null;
    model: string;
    status: "running" | "done" | "failed" | "escalated" | "cancelled";
    summary: string | null;
    result: Record<string, unknown>;
    usage: {
      tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
      costUsd: number;
      costSource: "provider" | "catalog" | "unknown";
      costBasis: string | null;
    };
    finishedAt?: string | null;
  }): Promise<SubtaskRunRecord> {
    await init();
    const result = await query<Record<string, unknown>>(
      `INSERT INTO subtask_runs
         (plan_id, plan_task_id, task_id, session_id, worktree, branch, model, status,
          summary, result, tokens_input, tokens_output, tokens_reasoning,
          tokens_cache_read, tokens_cache_write, cost_usd, cost_source, cost_basis, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
               $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        input.planId,
        input.planTaskId,
        input.taskId,
        input.sessionId,
        input.worktree,
        input.branch,
        input.model,
        input.status,
        input.summary,
        JSON.stringify(input.result),
        input.usage.tokens.input,
        input.usage.tokens.output,
        input.usage.tokens.reasoning,
        input.usage.tokens.cacheRead,
        input.usage.tokens.cacheWrite,
        input.usage.costUsd,
        input.usage.costSource,
        input.usage.costBasis,
        input.finishedAt ?? null,
      ],
    );
    return mapSubtaskRun(result.rows[0]!);
  }

  async function updateSubtaskRun(
    id: string,
    patch: {
      status?: SubtaskRunRecord["status"];
      sessionId?: string | null;
      summary?: string | null;
      result?: Record<string, unknown>;
      usage?: {
        tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
        costUsd: number;
        costSource: "provider" | "catalog" | "unknown";
        costBasis: string | null;
      };
      finishedAt?: string | null;
    },
  ): Promise<SubtaskRunRecord | null> {
    await init();
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      values.push(value);
      sets.push(`${sql} = $${values.length}`);
    };
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.sessionId !== undefined) push("session_id", patch.sessionId);
    if (patch.summary !== undefined) push("summary", patch.summary);
    if (patch.result !== undefined) push("result", JSON.stringify(patch.result));
    if (patch.usage) {
      push("tokens_input", patch.usage.tokens.input);
      push("tokens_output", patch.usage.tokens.output);
      push("tokens_reasoning", patch.usage.tokens.reasoning);
      push("tokens_cache_read", patch.usage.tokens.cacheRead);
      push("tokens_cache_write", patch.usage.tokens.cacheWrite);
      push("cost_usd", patch.usage.costUsd);
      push("cost_source", patch.usage.costSource);
      push("cost_basis", patch.usage.costBasis);
    }
    if (patch.finishedAt !== undefined) push("finished_at", patch.finishedAt);
    if (sets.length === 0) return null;
    values.push(id);
    const result = await query<Record<string, unknown>>(
      `UPDATE subtask_runs SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    return result.rows[0] ? mapSubtaskRun(result.rows[0]) : null;
  }

  async function listSubtaskRuns(planId: string, planTaskId?: string): Promise<SubtaskRunRecord[]> {
    await init();
    const values: unknown[] = [planId];
    let where = "plan_id = $1";
    if (planTaskId) {
      values.push(planTaskId);
      where += ` AND plan_task_id = $${values.length}`;
    }
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM subtask_runs WHERE ${where} ORDER BY started_at DESC`,
      values,
    );
    return result.rows.map(mapSubtaskRun);
  }

  async function createPhaseClosure(input: {
    planId: string;
    phase: number;
    status: "closed" | "blocked" | "cancelled";
    gateRunId: string | null;
    codeReviewId: string | null;
    securityReviewId: string | null;
    report: Record<string, unknown>;
    usage: {
      tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
      costUsd: number;
      costSource: "provider" | "catalog" | "unknown";
    };
  }): Promise<PhaseClosureRecord> {
    await init();
    const result = await query<Record<string, unknown>>(
      `INSERT INTO phase_closures
         (plan_id, phase, status, gate_run_id, code_review_id, security_review_id, report,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          cost_usd, cost_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        input.planId,
        input.phase,
        input.status,
        input.gateRunId,
        input.codeReviewId,
        input.securityReviewId,
        JSON.stringify(input.report),
        input.usage.tokens.input,
        input.usage.tokens.output,
        input.usage.tokens.reasoning,
        input.usage.tokens.cacheRead,
        input.usage.tokens.cacheWrite,
        input.usage.costUsd,
        input.usage.costSource,
      ],
    );
    return mapPhaseClosure(result.rows[0]!);
  }

  async function getPhaseClosure(planId: string, phase: number): Promise<PhaseClosureRecord | null> {
    await init();
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM phase_closures WHERE plan_id = $1 AND phase = $2`,
      [planId, phase],
    );
    return result.rows[0] ? mapPhaseClosure(result.rows[0]) : null;
  }

  async function listPhaseClosures(planId: string): Promise<PhaseClosureRecord[]> {
    await init();
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM phase_closures WHERE plan_id = $1 ORDER BY phase`,
      [planId],
    );
    return result.rows.map(mapPhaseClosure);
  }

  async function listPlanTasksByWorktree(projectId: string): Promise<PlanTaskRecord[]> {
    await init();
    const result = await query<PlanTaskRow>(
      `SELECT t.* FROM plan_tasks t
       JOIN plans p ON p.id = t.plan_id
       WHERE p.project_id = $1 AND t.worktree IS NOT NULL
       ORDER BY t.updated_at DESC`,
      [projectId],
    );
    return result.rows.map(mapPlanTask);
  }

  async function listStalePlanTasks(projectId: string, olderThanMinutes = 60): Promise<PlanTaskRecord[]> {
    await init();
    const result = await query<PlanTaskRow>(
      `SELECT t.* FROM plan_tasks t
       JOIN plans p ON p.id = t.plan_id
       WHERE p.project_id = $1
         AND t.status IN ('running', 'review')
         AND t.updated_at < now() - ($2::text || ' minutes')::interval
       ORDER BY t.updated_at ASC`,
      [projectId, Math.max(5, Math.round(olderThanMinutes))],
    );
    return result.rows.map(mapPlanTask);
  }

  async function updateProjectSettings(
    projectId: string,
    settings: { autonomy?: Autonomy; maxConcurrency?: number },
  ): Promise<void> {
    await init();
    const sets: string[] = [];
    const values: unknown[] = [];
    if (settings.autonomy !== undefined) {
      values.push(settings.autonomy);
      sets.push(`autonomy = $${values.length}`);
    }
    if (settings.maxConcurrency !== undefined) {
      values.push(settings.maxConcurrency);
      sets.push(`max_concurrency = $${values.length}`);
    }
    if (sets.length === 0) return;
    values.push(projectId);
    await query(`UPDATE factory_projects SET ${sets.join(", ")}, updated_at = now() WHERE project_id = $${values.length}`, values);
  }

  async function deletePlan(projectId: string, planId: string): Promise<boolean> {
    await init();
    const result = await query(`DELETE FROM plans WHERE project_id = $1 AND id = $2`, [projectId, planId]);
    return (result.rowCount ?? 0) > 0;
  }

  return {
    createPlan,
    getPlan,
    listPlans,
    updatePlan,
    createPlanTask,
    listPlanTasks,
    getPlanTask,
    getPlanTaskByTaskId,
    updatePlanTask,
    createPlanReview,
    listPlanReviews,
    createPlanValidation,
    listPlanValidations,
    createSubtaskRun,
    updateSubtaskRun,
    listSubtaskRuns,
    createPhaseClosure,
    getPhaseClosure,
    listPhaseClosures,
    listPlanTasksByWorktree,
    listStalePlanTasks,
    updateProjectSettings,
    deletePlan,
  };
}

export type PlanStore = ReturnType<typeof createPlanStore>;
