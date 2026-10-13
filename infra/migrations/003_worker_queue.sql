-- S06 durable worker queue, leased claims and fenced effects. Never edit prior migrations.
CREATE TABLE worker_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 20),
  max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(128),
  lease_token uuid,
  leased_until timestamptz,
  heartbeat_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  last_error varchar(1000),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY(project_id,task_id,run_id) REFERENCES task_runs(project_id,task_id,id) ON DELETE RESTRICT,
  CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND leased_until IS NOT NULL)
    OR (status <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND leased_until IS NULL)
  ),
  CHECK (status <> 'succeeded' OR result IS NOT NULL),
  CHECK (status NOT IN ('succeeded','failed','cancelled') OR finished_at IS NOT NULL)
);
CREATE INDEX worker_jobs_ready_idx ON worker_jobs(available_at,created_at,id) WHERE status='queued';
CREATE INDEX worker_jobs_expired_idx ON worker_jobs(leased_until,id) WHERE status='running';
CREATE INDEX worker_jobs_scope_idx ON worker_jobs(project_id,task_id,id);
CREATE TABLE worker_effects (
 run_id uuid PRIMARY KEY REFERENCES task_runs(id) ON DELETE RESTRICT,
 job_id uuid NOT NULL UNIQUE REFERENCES worker_jobs(id) ON DELETE RESTRICT,
 output jsonb NOT NULL CHECK (jsonb_typeof(output)='object'),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
-- Past queued runs from S05 become durable jobs without restarting completed workflow runs.
INSERT INTO worker_jobs(id,project_id,task_id,run_id)
SELECT r.id,r.project_id,r.task_id,r.id FROM task_runs r
JOIN tasks t ON t.project_id=r.project_id AND t.id=r.task_id AND t.current_run_id=r.id
WHERE t.status='queued'
ON CONFLICT(run_id) DO NOTHING;
