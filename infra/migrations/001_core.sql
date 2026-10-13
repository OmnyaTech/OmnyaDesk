-- S04: PostgreSQL canonical storage. Former infra/sql/001_initial.sql is a draft and MUST NOT be run.
-- All identifiers use UUID; foreign keys include project scope, preventing cross-project linkages.
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  name varchar(140) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 140),
  repository_root text CHECK (repository_root IS NULL OR char_length(repository_root) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_name_nonblank CHECK (name = btrim(name))
);
CREATE TABLE offices (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name varchar(140) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 140),
  template text NOT NULL CHECK (template IN ('startup','accounting','custom')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,id)
);
CREATE INDEX offices_project_idx ON offices(project_id);
CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  office_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  title varchar(140) NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 140),
  description varchar(4000) NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','queued','planning','implementing','testing','reviewing',
      'awaiting_approval','approved','changes_requested','retrying','blocked','failed','cancelled','expired')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  current_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id,office_id) REFERENCES offices(project_id,id) ON DELETE RESTRICT,
  CHECK (title = btrim(title))
);
CREATE INDEX tasks_project_created_idx ON tasks(project_id,created_at DESC,id DESC);
CREATE TABLE task_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  project_id uuid NOT NULL,
  office_id uuid NOT NULL,
  task_id uuid NOT NULL,
  run_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','agent','integration','system')),
  actor_id text NOT NULL,
  correlation_id uuid,
  causation_id uuid,
  source text NOT NULL CHECK (source IN ('api','cli','mcp','vscode','web','worker','system')),
  type text NOT NULL CHECK (type IN ('task.created','task.status_changed','task_run.started',
    'task_run.finished','approval.requested','approval.decided','artifact.recorded')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,office_id) REFERENCES offices(project_id,id) ON DELETE RESTRICT,
  CHECK ((actor_kind = 'system' AND actor_id = 'system') OR
         (actor_kind <> 'system' AND actor_id <> 'system'))
);
CREATE INDEX task_events_scope_cursor_idx ON task_events(project_id,sequence);
CREATE INDEX task_events_task_cursor_idx ON task_events(task_id,sequence);
-- Audit events are append-only even when accessed by their owner; no hard deletes.
CREATE FUNCTION reject_task_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_events is append-only';
END;
$$;
CREATE TRIGGER task_events_immutable
BEFORE UPDATE OR DELETE ON task_events
FOR EACH ROW EXECUTE FUNCTION reject_task_event_mutation();
