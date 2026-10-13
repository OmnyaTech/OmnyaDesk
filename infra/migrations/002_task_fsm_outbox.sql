-- S05: atomic FSM, run identity, transactional outbox and request idempotency.
-- Append-only task_events from 001_core.sql remains the source of truth.
CREATE TABLE task_runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, task_id, id),
  UNIQUE(task_id, attempt),
  FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT
);
ALTER TABLE tasks ADD CONSTRAINT tasks_current_run_fk
  FOREIGN KEY(project_id,id,current_run_id)
  REFERENCES task_runs(project_id,task_id,id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE task_events ADD CONSTRAINT task_events_run_fk
  FOREIGN KEY(project_id,task_id,run_id)
  REFERENCES task_runs(project_id,task_id,id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE task_commands (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  command_key uuid NOT NULL,
  request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
  response_json jsonb NOT NULL CHECK(jsonb_typeof(response_json)='object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,task_id,command_key),
  FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT
);

CREATE TABLE task_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  event_id uuid NOT NULL UNIQUE REFERENCES task_events(event_id) ON DELETE RESTRICT,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  inserted_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT
);
CREATE INDEX task_outbox_pending_idx ON task_outbox(id) WHERE delivered_at IS NULL;
CREATE INDEX task_outbox_project_cursor_idx ON task_outbox(project_id,id);

CREATE FUNCTION restrict_outbox_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.project_id IS DISTINCT FROM OLD.project_id OR
     NEW.task_id IS DISTINCT FROM OLD.task_id OR
     NEW.event_id IS DISTINCT FROM OLD.event_id OR
     NEW.payload IS DISTINCT FROM OLD.payload OR
     NEW.inserted_at IS DISTINCT FROM OLD.inserted_at OR
     NEW.delivered_at IS DISTINCT FROM OLD.delivered_at AND OLD.delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'task_outbox payload/identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_outbox_update_guard BEFORE UPDATE ON task_outbox
  FOR EACH ROW EXECUTE FUNCTION restrict_outbox_mutation();
CREATE TRIGGER task_outbox_delete_guard BEFORE DELETE ON task_outbox
  FOR EACH ROW EXECUTE FUNCTION reject_task_event_mutation();

-- The original S04 task.created event had no outbox. Backfill once, transactionally.
INSERT INTO task_outbox(project_id,task_id,event_id,payload)
SELECT e.project_id,e.task_id,e.event_id,
  jsonb_build_object(
    'schemaVersion',e.schema_version,'eventId',e.event_id,'sequence',e.sequence,
    'occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'projectId',e.project_id,'officeId',e.office_id,'taskId',e.task_id,'runId',e.run_id,
    'actor',jsonb_build_object('kind',e.actor_kind,'id',e.actor_id),
    'correlationId',e.correlation_id,'causationId',e.causation_id,
    'source',e.source,'type',e.type,'payload',e.payload)
FROM task_events e
WHERE e.type='task.created'
ON CONFLICT(event_id) DO NOTHING;
