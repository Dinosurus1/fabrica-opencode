-- 007 · execution log, presupuestos y precios versionados
--
-- Completa el registro de ejecución para medir coste por tarea terminada,
-- añade reservas atómicas de presupuesto por ejecución y una tabla de precios
-- versionada. Es aditivo e idempotente.

BEGIN;

ALTER TABLE factory_execution_log
  ADD COLUMN IF NOT EXISTS project_id text,
  ADD COLUMN IF NOT EXISTS phase integer,
  ADD COLUMN IF NOT EXISTS parent_execution_id uuid
    REFERENCES factory_execution_log (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mode text,
  ADD COLUMN IF NOT EXISTS selection_reason text,
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS tool_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS gate_run_id uuid
    REFERENCES gate_runs (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS price_version text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS factory_execution_log_project_idx
  ON factory_execution_log (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS factory_execution_log_status_idx
  ON factory_execution_log (status, started_at DESC);
CREATE INDEX IF NOT EXISTS factory_execution_log_parent_idx
  ON factory_execution_log (parent_execution_id);
CREATE INDEX IF NOT EXISTS factory_execution_log_gate_idx
  ON factory_execution_log (gate_run_id);

CREATE TABLE IF NOT EXISTS factory_budgets (
  key text PRIMARY KEY,
  project_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('global', 'phase', 'task')),
  plan_id uuid,
  phase integer,
  task_id text,
  max_tokens bigint,
  max_cost_usd numeric(14,6),
  reserved_tokens bigint NOT NULL DEFAULT 0,
  reserved_cost_usd numeric(14,6) NOT NULL DEFAULT 0,
  spent_tokens bigint NOT NULL DEFAULT 0,
  spent_cost_usd numeric(14,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS factory_budgets_project_idx
  ON factory_budgets (project_id, scope);

CREATE TABLE IF NOT EXISTS factory_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL
    REFERENCES factory_execution_log (id) ON DELETE CASCADE,
  budget_key text NOT NULL
    REFERENCES factory_budgets (key) ON DELETE CASCADE,
  reserved_tokens bigint NOT NULL DEFAULT 0,
  reserved_cost_usd numeric(14,6) NOT NULL DEFAULT 0,
  settled_tokens bigint,
  settled_cost_usd numeric(14,6),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'settled', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX IF NOT EXISTS factory_budget_reservations_execution_idx
  ON factory_budget_reservations (execution_id);
CREATE INDEX IF NOT EXISTS factory_budget_reservations_status_idx
  ON factory_budget_reservations (status, created_at DESC);

CREATE TABLE IF NOT EXISTS factory_model_prices (
  version text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  input numeric(14,6),
  output numeric(14,6),
  cache_read numeric(14,6),
  cache_write numeric(14,6),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version, provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS factory_model_prices_model_idx
  ON factory_model_prices (provider_id, model_id, version DESC);

INSERT INTO factory_meta (key, value, updated_at)
VALUES ('schema_version', '7'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now();

COMMIT;
