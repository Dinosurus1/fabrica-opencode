-- Migración de compuertas de calidad, revisiones y cierre de tareas.
-- Idempotente. No modifica `memories` ni `capture_state`.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('opencode_factory_quality_migration'));

ALTER TABLE factory_projects
  ADD COLUMN IF NOT EXISTS quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS baseline_at timestamptz;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS closure_report jsonb,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

CREATE TABLE IF NOT EXISTS gate_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  task_id uuid,
  iteration integer NOT NULL DEFAULT 1 CHECK (iteration BETWEEN 1 AND 3),
  mode text NOT NULL DEFAULT 'check' CHECK (mode IN ('check', 'baseline')),
  status text NOT NULL CHECK (status IN ('pass', 'fail', 'incomplete', 'error')),
  gates jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text,
  blocking_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  git_branch text,
  git_commit text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gate_runs_project_created_idx
  ON gate_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gate_runs_task_idx
  ON gate_runs (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  task_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('security', 'code', 'qa')),
  model text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('approved', 'changes_required')),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_blocking integer NOT NULL DEFAULT 0 CHECK (open_blocking >= 0),
  summary text,
  gate_run_id uuid,
  iteration integer NOT NULL DEFAULT 1 CHECK (iteration BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_runs_task_role_idx
  ON review_runs (task_id, role, created_at DESC);

CREATE TABLE IF NOT EXISTS factory_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO factory_meta (key, value, updated_at)
VALUES ('schema_version', '2'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;
