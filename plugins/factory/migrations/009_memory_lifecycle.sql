-- 009 · memoria viva y consolidación
--
-- Añade entity_key, documento estructurado, historial, verificación y soft
-- delete a `memories` (si existe), más backups de memoria. Es aditivo e
-- idempotente. No borra memorias.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memories') IS NOT NULL THEN
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS entity_key text;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS doc jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS related text[] NOT NULL DEFAULT '{}'::text[];
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS merged_into uuid
      REFERENCES memories (id) ON DELETE SET NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS memories_entity_key_idx
      ON memories (scope, project_id, entity_key)
      WHERE entity_key IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS memories_deleted_idx
      ON memories (deleted_at)
      WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS memory_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_backups_created_idx
  ON memory_backups (created_at DESC);

INSERT INTO factory_meta (key, value, updated_at)
VALUES ('schema_version', '9'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now();

COMMIT;
