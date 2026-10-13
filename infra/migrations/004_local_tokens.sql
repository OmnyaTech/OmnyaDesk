-- S07 local access tokens. Never persist raw bearer secrets.
CREATE TABLE api_tokens (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 subject_id uuid NOT NULL,
 subject_kind varchar(20) NOT NULL CHECK (subject_kind IN ('human','integration')),
 secret_sha256 char(64) NOT NULL UNIQUE CHECK(secret_sha256 ~ '^[a-f0-9]{64}$'),
 scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 8),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(expires_at > created_at),
 CHECK (scopes <@ ARRAY['projects:read','tasks:read','tasks:create','tasks:transition','events:read']::text[]),
 CHECK (array_position(scopes,NULL) IS NULL)
);
CREATE INDEX api_tokens_project_subject_idx ON api_tokens(project_id,subject_id);
