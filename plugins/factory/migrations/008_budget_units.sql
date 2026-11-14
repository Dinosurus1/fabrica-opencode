-- 008 · presupuesto en coste o tokens ponderados, calibración y sobreconsumo
--
-- Renombra max_tokens a token_budget (evita confundirlo con el límite de
-- salida de las APIs), separa tokens ponderados y registra reserva/consumo
-- real para detectar sobreconsumo. Es aditivo e idempotente.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'factory_profile_assignments' AND column_name = 'max_tokens'
  ) THEN
    ALTER TABLE factory_profile_assignments RENAME COLUMN max_tokens TO token_budget;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'factory_budgets' AND column_name = 'max_tokens'
  ) THEN
    ALTER TABLE factory_budgets RENAME COLUMN max_tokens TO token_budget;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'factory_budgets' AND column_name = 'reserved_tokens'
  ) THEN
    ALTER TABLE factory_budgets RENAME COLUMN reserved_tokens TO reserved_weighted_tokens;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'factory_budgets' AND column_name = 'spent_tokens'
  ) THEN
    ALTER TABLE factory_budgets RENAME COLUMN spent_tokens TO spent_weighted_tokens;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'factory_budget_reservations' AND column_name = 'reserved_tokens'
  ) THEN
    ALTER TABLE factory_budget_reservations RENAME COLUMN reserved_tokens TO reserved_weighted_tokens;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'factory_budget_reservations' AND column_name = 'settled_tokens'
  ) THEN
    ALTER TABLE factory_budget_reservations RENAME COLUMN settled_tokens TO settled_weighted_tokens;
  END IF;
END $$;

ALTER TABLE factory_execution_log
  ADD COLUMN IF NOT EXISTS weighted_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_unit text,
  ADD COLUMN IF NOT EXISTS reserved_weighted_tokens bigint,
  ADD COLUMN IF NOT EXISTS reserved_cost_usd numeric(14,6),
  ADD COLUMN IF NOT EXISTS reservation_source text,
  ADD COLUMN IF NOT EXISTS overrun_ratio numeric(10,4);

CREATE INDEX IF NOT EXISTS factory_execution_log_overrun_idx
  ON factory_execution_log (role, overrun_ratio DESC)
  WHERE overrun_ratio IS NOT NULL;

INSERT INTO factory_meta (key, value, updated_at)
VALUES ('schema_version', '8'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now();

COMMIT;
