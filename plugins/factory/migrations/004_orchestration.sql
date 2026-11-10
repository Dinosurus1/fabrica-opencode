-- Migración 004: plan por fases, worktrees, subtareas, revisiones y cierres.
-- Idempotente. Solo añade tablas/columnas propias de la fábrica.
-- No modifica `memories` ni `capture_state`.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('opencode_factory_orchestration_migration'));

-- Autonomía y concurrencia por proyecto.
ALTER TABLE factory_projects
  ADD COLUMN IF NOT EXISTS autonomy text NOT NULL DEFAULT 'supervised'
    CHECK (autonomy IN ('supervised', 'semi_autonomous', 'autonomous')),
  ADD COLUMN IF NOT EXISTS max_concurrency integer NOT NULL DEFAULT 3
    CHECK (max_concurrency BETWEEN 1 AND 8);

-- Modelo que escribió la tarea, para el ruteo de revisores.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS author_model text;

CREATE TABLE IF NOT EXISTS plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          text NOT NULL REFERENCES factory_projects(project_id) ON DELETE CASCADE,
  project_path        text NOT NULL,
  title               text NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review_pending', 'validated', 'approved', 'executing', 'paused', 'completed', 'cancelled')),
  autonomy            text NOT NULL DEFAULT 'supervised'
    CHECK (autonomy IN ('supervised', 'semi_autonomous', 'autonomous')),
  max_concurrency     integer NOT NULL DEFAULT 3
    CHECK (max_concurrency BETWEEN 1 AND 8),
  review_round        integer NOT NULL DEFAULT 0
    CHECK (review_round BETWEEN 0 AND 2),
  review_findings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation          jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_documents    jsonb NOT NULL DEFAULT '[]'::jsonb,
  baseline            jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plans_project_created_idx
  ON plans (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS plans_project_status_idx
  ON plans (project_id, status);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  task_id             uuid UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  phase               integer NOT NULL CHECK (phase >= 0),
  phase_name          text,
  order_index         integer NOT NULL DEFAULT 0,
  title               text NOT NULL,
  description         text NOT NULL,
  acceptance_criteria text NOT NULL,
  difficulty          text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  difficulty_reason   text NOT NULL,
  assignee            text NOT NULL CHECK (assignee IN ('orchestrator', 'implementer')),
  model               text NOT NULL,
  files_owned         text[] NOT NULL DEFAULT '{}'::text[],
  risk_flags          text[] NOT NULL DEFAULT '{}'::text[],
  parallelizable      boolean NOT NULL DEFAULT true,
  depends_on          uuid[] NOT NULL DEFAULT '{}'::uuid[],
  worktree            text,
  branch              text,
  status              text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'running', 'review', 'blocked', 'merged', 'done', 'failed', 'escalated', 'cancelled')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  session_id          text,
  review_route        jsonb NOT NULL DEFAULT '{}'::jsonb,
  result              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error          text,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (acceptance_criteria <> ''),
  CHECK (cardinality(files_owned) > 0)
);

CREATE INDEX IF NOT EXISTS plan_tasks_plan_phase_idx
  ON plan_tasks (plan_id, phase, order_index);
CREATE INDEX IF NOT EXISTS plan_tasks_plan_status_idx
  ON plan_tasks (plan_id, status);
CREATE INDEX IF NOT EXISTS plan_tasks_task_idx
  ON plan_tasks (task_id);
CREATE INDEX IF NOT EXISTS plan_tasks_worktree_idx
  ON plan_tasks (worktree) WHERE worktree IS NOT NULL;

CREATE TABLE IF NOT EXISTS plan_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  round               integer NOT NULL CHECK (round BETWEEN 1 AND 2),
  model               text NOT NULL,
  verdict             text NOT NULL CHECK (verdict IN ('approved', 'changes_required')),
  findings            jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary             text,
  session_id          text,
  tokens_input        bigint NOT NULL DEFAULT 0,
  tokens_output       bigint NOT NULL DEFAULT 0,
  tokens_reasoning    bigint NOT NULL DEFAULT 0,
  tokens_cache_read   bigint NOT NULL DEFAULT 0,
  tokens_cache_write  bigint NOT NULL DEFAULT 0,
  cost_usd            numeric(14, 6) NOT NULL DEFAULT 0,
  cost_source         text NOT NULL DEFAULT 'unknown'
    CHECK (cost_source IN ('provider', 'catalog', 'unknown')),
  cost_basis          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, round)
);

CREATE INDEX IF NOT EXISTS plan_reviews_plan_idx
  ON plan_reviews (plan_id, round DESC);

CREATE TABLE IF NOT EXISTS plan_validations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  status              text NOT NULL CHECK (status IN ('pass', 'fail')),
  errors              jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings            jsonb NOT NULL DEFAULT '[]'::jsonb,
  waves               jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_validations_plan_idx
  ON plan_validations (plan_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subtask_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  plan_task_id        uuid NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  task_id             uuid REFERENCES tasks(id) ON DELETE SET NULL,
  session_id          text,
  worktree            text,
  branch              text,
  model               text NOT NULL,
  status              text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'failed', 'escalated', 'cancelled')),
  summary             text,
  result              jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens_input        bigint NOT NULL DEFAULT 0,
  tokens_output       bigint NOT NULL DEFAULT 0,
  tokens_reasoning    bigint NOT NULL DEFAULT 0,
  tokens_cache_read   bigint NOT NULL DEFAULT 0,
  tokens_cache_write  bigint NOT NULL DEFAULT 0,
  cost_usd            numeric(14, 6) NOT NULL DEFAULT 0,
  cost_source         text NOT NULL DEFAULT 'unknown'
    CHECK (cost_source IN ('provider', 'catalog', 'unknown')),
  cost_basis          text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);

CREATE INDEX IF NOT EXISTS subtask_runs_plan_task_idx
  ON subtask_runs (plan_id, plan_task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS subtask_runs_status_idx
  ON subtask_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS phase_closures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  phase               integer NOT NULL CHECK (phase >= 0),
  status              text NOT NULL CHECK (status IN ('closed', 'blocked', 'cancelled')),
  gate_run_id         uuid REFERENCES gate_runs(id) ON DELETE SET NULL,
  code_review_id      uuid REFERENCES review_runs(id) ON DELETE SET NULL,
  security_review_id  uuid REFERENCES review_runs(id) ON DELETE SET NULL,
  report              jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens_input        bigint NOT NULL DEFAULT 0,
  tokens_output       bigint NOT NULL DEFAULT 0,
  tokens_reasoning    bigint NOT NULL DEFAULT 0,
  tokens_cache_read   bigint NOT NULL DEFAULT 0,
  tokens_cache_write  bigint NOT NULL DEFAULT 0,
  cost_usd            numeric(14, 6) NOT NULL DEFAULT 0,
  cost_source         text NOT NULL DEFAULT 'unknown'
    CHECK (cost_source IN ('provider', 'catalog', 'unknown')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, phase)
);

CREATE INDEX IF NOT EXISTS phase_closures_plan_idx
  ON phase_closures (plan_id, phase);

INSERT INTO factory_meta (key, value, updated_at)
VALUES ('schema_version', '4'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now();

COMMIT;
