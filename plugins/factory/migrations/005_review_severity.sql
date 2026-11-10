-- 005 · severidad del plan-reviewer y estado exhausted
--
-- Añade el estado de revisión agotada, la deuda residual y las métricas por
-- ronda. No borra datos ni toca `memories`/`capture_state`.

BEGIN;

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS review_exhausted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS residual_findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS approval_waiver jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE plan_reviews
  ADD COLUMN IF NOT EXISTS blocking_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advisory_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS new_findings integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS resolved_findings integer NOT NULL DEFAULT 0;

-- Permitir una tercera ronda solo con confirmación explícita del usuario.
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_review_round_check;
ALTER TABLE plans
  ADD CONSTRAINT plans_review_round_check CHECK (review_round BETWEEN 0 AND 3);

ALTER TABLE plan_reviews DROP CONSTRAINT IF EXISTS plan_reviews_round_check;
ALTER TABLE plan_reviews
  ADD CONSTRAINT plan_reviews_round_check CHECK (round BETWEEN 1 AND 3);

INSERT INTO factory_meta (key, value, updated_at)
VALUES ('schema_version', '5'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now();

COMMIT;
