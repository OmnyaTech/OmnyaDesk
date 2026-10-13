-- ESBOÇO de esquema PostgreSQL. NÃO executado nem testado contra Postgres.
-- Projetado para orientar OD-002; migrations reais exigem revisão.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  repo_root text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  role text NOT NULL,
  provider_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'created',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  agent_id uuid REFERENCES agents(id),
  status text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  started_at timestamptz,
  ended_at timestamptz,
  budget_cents integer NOT NULL DEFAULT 0
);
CREATE TABLE task_events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  run_id uuid REFERENCES task_runs(id),
  type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_id_id_idx ON task_events(task_id,id);
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  decided_by text,
  status text NOT NULL DEFAULT 'pending',
  diff_hash text,
  decided_at timestamptz
);
CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  run_id uuid REFERENCES task_runs(id),
  storage_path text NOT NULL,
  content_type text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0)
);
CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
