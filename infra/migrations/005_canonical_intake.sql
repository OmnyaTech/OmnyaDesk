-- S09: trusted token origin/channel and atomic canonical task ingress.
ALTER TABLE api_tokens
  ADD COLUMN client_origin text NOT NULL DEFAULT 'cli'
    CHECK (client_origin IN ('chatgpt','desktop_commander','codex','vscode','web','cli','other')),
  ADD COLUMN intake_channel text NOT NULL DEFAULT 'api'
    CHECK (intake_channel IN ('api','mcp'));

CREATE TABLE task_intake_requests (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  office_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('human','integration')),
  token_id uuid NOT NULL REFERENCES api_tokens(id) ON DELETE RESTRICT,
  client_origin text NOT NULL CHECK (client_origin IN ('chatgpt','desktop_commander','codex','vscode','web','cli','other')),
  intake_channel text NOT NULL CHECK (intake_channel IN ('api','mcp')),
  idempotency_key uuid NOT NULL,
  request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  response_json jsonb NOT NULL CHECK(jsonb_typeof(response_json)='object'),
  event_id uuid NOT NULL UNIQUE REFERENCES task_events(event_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,subject_id,idempotency_key),
  UNIQUE(task_id),
  FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,office_id) REFERENCES offices(project_id,id) ON DELETE RESTRICT
);
CREATE INDEX task_intake_project_recent_idx ON task_intake_requests(project_id,created_at DESC,task_id);
-- Existing S04-S08 tasks did not come through the canonical S09 ingress and
-- retain their historic events. No synthetic origin is invented for them.
