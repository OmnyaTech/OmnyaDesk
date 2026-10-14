-- S27 least-privilege attachment write scope. All earlier migration hashes remain unchanged.
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_allowed_scopes;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_allowed_scopes CHECK (
 scopes <@ ARRAY['projects:read','tasks:read','tasks:create','tasks:transition',
 'events:read','git:propose','git:review','git:integrate','files:write']::text[]
);
