-- Migración de uso de tokens y costo estimado por modelo.
-- Idempotente. Solo añade columnas a `review_runs` y sube schema_version.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('opencode_factory_quality_migration'));

ALTER TABLE review_runs
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS tokens_input bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_output bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_reasoning bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_cache_read bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_cache_write bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_usd numeric(14, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_source text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS cost_basis text;

ALTER TABLE review_runs
  DROP CONSTRAINT IF EXISTS review_runs_cost_source_check;

ALTER TABLE review_runs
  ADD CONSTRAINT review_runs_cost_source_check
  CHECK (cost_source IN ('provider', 'catalog', 'unknown'));

INSERT INTO factory_meta (key, value, updated_at)
VALUES ('schema_version', '3'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now();

COMMIT;
