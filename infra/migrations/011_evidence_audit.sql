-- S14: content-addressed append-only evidence, version chain and immutable review payloads.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE evidence_entries (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL,
 task_id uuid NOT NULL,
 run_id uuid,
 kind varchar(20) NOT NULL CHECK(kind IN ('log','diff','artifact','review_diff','review_approval')),
 scope_key varchar(180) NOT NULL CHECK(scope_key ~ '^[a-zA-Z0-9_./:-]{1,180}$'),
 version integer NOT NULL CHECK(version >= 1),
 actor_id varchar(100) NOT NULL CHECK(actor_id ~ '^[a-zA-Z0-9_.:-]{1,100}$'),
 content bytea NOT NULL CHECK(octet_length(content) <= 65536),
 content_sha256 char(64) NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=2048),
 previous_chain char(64),
 chain_sha256 char(64) NOT NULL CHECK(chain_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT,
 UNIQUE(project_id,task_id,kind,scope_key,version),
 CHECK((version=1 AND previous_chain IS NULL) OR (version>1 AND previous_chain IS NOT NULL))
);
CREATE INDEX evidence_entries_run_idx ON evidence_entries(project_id,task_id,run_id,created_at,id);
CREATE INDEX evidence_entries_scope_idx ON evidence_entries(project_id,task_id,kind,scope_key,version DESC);

CREATE OR REPLACE FUNCTION enforce_evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_version integer; last_chain char(64); expected char(64);
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'evidence_entries is append-only'; END IF;
 IF NEW.content_sha256 <> encode(digest(NEW.content,'sha256'),'hex') THEN
  RAISE EXCEPTION 'evidence payload digest mismatch';
 END IF;
 SELECT version,chain_sha256 INTO last_version,last_chain FROM evidence_entries
 WHERE project_id=NEW.project_id AND task_id=NEW.task_id
 AND kind=NEW.kind AND scope_key=NEW.scope_key ORDER BY version DESC LIMIT 1;
 IF NEW.version<>COALESCE(last_version,0)+1
  OR NEW.previous_chain IS DISTINCT FROM last_chain THEN
  RAISE EXCEPTION 'evidence version/previous chain mismatch';
 END IF;
 IF NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM task_runs WHERE id=NEW.run_id
   AND project_id=NEW.project_id AND task_id=NEW.task_id
 ) AND NOT EXISTS (
  SELECT 1 FROM execution_worktrees WHERE run_id=NEW.run_id
   AND project_id=NEW.project_id AND task_id=NEW.task_id
 ) THEN RAISE EXCEPTION 'evidence run outside task'; END IF;
 expected:=encode(digest(convert_to(concat_ws('|',
  COALESCE(NEW.previous_chain,''),NEW.project_id::text,NEW.task_id::text,
  NEW.kind,NEW.scope_key,NEW.version::text,NEW.content_sha256,
  NEW.metadata::text,COALESCE(NEW.run_id::text,''),NEW.actor_id),'UTF8'),'sha256'),'hex');
 IF NEW.chain_sha256<>expected THEN RAISE EXCEPTION 'evidence chain digest mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evidence_entries_immutable BEFORE INSERT OR UPDATE OR DELETE ON evidence_entries
 FOR EACH ROW EXECUTE FUNCTION enforce_evidence_append_only();

ALTER TABLE git_integration_requests
 ADD COLUMN review_evidence_id uuid REFERENCES evidence_entries(id) ON DELETE RESTRICT;
CREATE INDEX git_integration_review_evidence_idx
 ON git_integration_requests(review_evidence_id) WHERE review_evidence_id IS NOT NULL;
