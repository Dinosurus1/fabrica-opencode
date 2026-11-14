-- 006 · Model & Agent Management (MAM)
--
-- Catálogo de modelos y agentes, perfiles de ejecución reutilizables,
-- asignaciones por rol, auditoría de cambios y registro de ejecuciones.
-- No toca `memories` ni `capture_state`; es aditivo e idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS factory_models (
  provider_id text NOT NULL,
  model_id text NOT NULL,
  name text,
  family text,
  type text NOT NULL DEFAULT 'chat',
  status text NOT NULL DEFAULT 'active',
  enabled boolean NOT NULL DEFAULT true,
  context_limit integer,
  input_limit integer,
  output_limit integer,
  cost_input numeric(12,6),
  cost_output numeric(12,6),
  cost_cache_read numeric(12,6),
  cost_cache_write numeric(12,6),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  variants jsonb NOT NULL DEFAULT '[]'::jsonb,
  authorized boolean NOT NULL DEFAULT true,
  prohibited boolean NOT NULL DEFAULT false,
  notes text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS factory_models_family_idx
  ON factory_models (family);
CREATE INDEX IF NOT EXISTS factory_models_status_idx
  ON factory_models (status, enabled, authorized, prohibited);

CREATE TABLE IF NOT EXISTS factory_agent_catalog (
  agent_id text PRIMARY KEY,
  name text,
  mode text,
  description text,
  role text,
  model_provider text,
  model_id text,
  model_variant text,
  steps integer,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS factory_execution_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  mode text NOT NULL DEFAULT 'hybrid'
    CHECK (mode IN ('auto', 'manual', 'hybrid')),
  is_default boolean NOT NULL DEFAULT false,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_profiles_one_default_idx
  ON factory_execution_profiles (is_default)
  WHERE is_default;

CREATE TABLE IF NOT EXISTS factory_profile_assignments (
  profile_id uuid NOT NULL
    REFERENCES factory_execution_profiles (id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  variant text,
  locked boolean NOT NULL DEFAULT true,
  max_cost_usd numeric(12,6),
  max_tokens integer,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, agent_id)
);

CREATE INDEX IF NOT EXISTS factory_profile_assignments_agent_idx
  ON factory_profile_assignments (agent_id);

CREATE TABLE IF NOT EXISTS factory_audit_events (
  id bigserial PRIMARY KEY,
  actor text NOT NULL DEFAULT 'factory',
  action text NOT NULL,
  target text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS factory_audit_events_created_idx
  ON factory_audit_events (created_at DESC);

CREATE TABLE IF NOT EXISTS factory_execution_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid
    REFERENCES factory_execution_profiles (id) ON DELETE SET NULL,
  session_id text,
  agent_id text,
  provider_id text,
  model_id text,
  role text,
  task_id text,
  plan_id text,
  tokens_input integer NOT NULL DEFAULT 0,
  tokens_output integer NOT NULL DEFAULT 0,
  tokens_reasoning integer NOT NULL DEFAULT 0,
  tokens_cache_read integer NOT NULL DEFAULT 0,
  tokens_cache_write integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6),
  cost_source text,
  status text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS factory_execution_log_agent_idx
  ON factory_execution_log (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS factory_execution_log_model_idx
  ON factory_execution_log (provider_id, model_id, started_at DESC);
CREATE INDEX IF NOT EXISTS factory_execution_log_session_idx
  ON factory_execution_log (session_id);

INSERT INTO factory_meta (key, value, updated_at)
VALUES ('schema_version', '6'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now();

COMMIT;
