-- Migración de la fábrica de software.
-- Idempotente. Solo añade tablas propias; no modifica `memories` ni `capture_state`.
-- Se ejecuta desde el plugin al primer uso de una tool.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('opencode_factory_migration'));

CREATE TABLE IF NOT EXISTS factory_projects (
  project_id   text PRIMARY KEY,
  name         text NOT NULL,
  path         text NOT NULL,
  stack        jsonb NOT NULL DEFAULT '{}'::jsonb,
  commands     jsonb NOT NULL DEFAULT '{}'::jsonb,
  conventions  jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes        text,
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           text NOT NULL,
  project_path         text,
  title                text NOT NULL,
  acceptance_criteria  text NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'blocked', 'done', 'cancelled')),
  result               text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks (project_id, status);
CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks (updated_at DESC);

COMMIT;
