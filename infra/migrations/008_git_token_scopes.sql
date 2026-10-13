-- S11: extend original S07 token scope whitelist through a NEW migration.
-- Previous migrations remain immutable with their SHA256 checksums.
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_scopes_check1;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_allowed_scopes CHECK(
 scopes <@ ARRAY['projects:read','tasks:read','tasks:create','tasks:transition','events:read',
                  'git:propose','git:review','git:integrate']::text[]
);
