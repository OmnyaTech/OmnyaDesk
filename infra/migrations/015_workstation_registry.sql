-- One-time workstation session, scoped project ACL and immutable resolved path registration.
CREATE TABLE workstation_sessions (
 id uuid PRIMARY KEY,
 subject_id uuid NOT NULL,
 secret_sha256 char(64) NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workstation_projects (
 workstation_id uuid NOT NULL REFERENCES workstation_sessions(id) ON DELETE CASCADE,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 canonical_root text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workstation_id,project_id),
 UNIQUE(workstation_id,canonical_root),
 CHECK(length(canonical_root) BETWEEN 3 AND 2048)
);
CREATE INDEX workstation_projects_by_project ON workstation_projects(project_id);
