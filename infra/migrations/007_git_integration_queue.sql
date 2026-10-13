-- S11: append-only decisions and a single per-project Git integration queue.
-- The approved object is tied to a candidate commit, tested merge tree and target HEAD.
CREATE TABLE git_integration_requests (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 task_id uuid NOT NULL,
 submitter_id uuid NOT NULL,
 candidate_ref varchar(180) NOT NULL CHECK(candidate_ref ~ '^refs/heads/[a-z0-9][a-z0-9/_-]*$'),
 candidate_sha char(40) NOT NULL CHECK(candidate_sha ~ '^[a-f0-9]{40}$'),
 base_sha char(40) NOT NULL CHECK(base_sha ~ '^[a-f0-9]{40}$'),
 state varchar(18) NOT NULL DEFAULT 'queued'
  CHECK(state IN ('queued','ready','conflict','tests_failed','stale','merged')),
 priority smallint NOT NULL DEFAULT 5 CHECK(priority BETWEEN 0 AND 10),
 reviewed_head char(40),
 tested_tree char(40),
 planned_commit char(40),
 review_sha256 char(64),
 validation_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(validation_json)='object'),
 approved_by uuid,
 approved_at timestamptz,
 merged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT,
 UNIQUE(project_id,task_id),
 CHECK((state IN ('ready','merged') AND reviewed_head IS NOT NULL AND tested_tree IS NOT NULL
  AND planned_commit IS NOT NULL AND review_sha256 IS NOT NULL) OR state NOT IN('ready','merged')),
 CHECK(state<>'merged' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND merged_at IS NOT NULL))
);
CREATE INDEX git_integrations_queue_idx ON git_integration_requests(project_id,priority DESC,created_at,id)
 WHERE state IN ('queued','stale','tests_failed','conflict','ready');

CREATE TABLE git_integration_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL REFERENCES git_integration_requests(id) ON DELETE RESTRICT,
 action varchar(16) NOT NULL CHECK(action IN('submitted','prepared','blocked','approved','stale','merged')),
 actor_id uuid NOT NULL,
 detail jsonb NOT NULL CHECK(jsonb_typeof(detail)='object'),
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX git_integration_audit_req_idx ON git_integration_audit(project_id,request_id,id);
CREATE OR REPLACE FUNCTION reject_git_integration_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'git_integration_audit is append-only'; END; $$;
CREATE TRIGGER git_integration_audit_immutable BEFORE UPDATE OR DELETE ON git_integration_audit
FOR EACH ROW EXECUTE FUNCTION reject_git_integration_audit_mutation();
