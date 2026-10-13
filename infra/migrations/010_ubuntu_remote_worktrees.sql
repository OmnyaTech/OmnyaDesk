-- S12 Ubuntu rework: preserve all historical local/WSL rows, distinguish remote worktrees.
ALTER TABLE execution_worktrees
 ADD COLUMN execution_backend text NOT NULL DEFAULT 'legacy_local'
 CHECK(execution_backend IN ('legacy_local','ubuntu_ssh_docker')),
 ADD COLUMN remote_host varchar(120),
 ADD COLUMN sandbox_image varchar(160);
ALTER TABLE execution_worktrees ADD CONSTRAINT execution_worktrees_remote_metadata CHECK (
 execution_backend='legacy_local'
 OR (remote_host IS NOT NULL AND sandbox_image ~ '^alpine@sha256:[a-f0-9]{64}$'
     AND checkout_path LIKE '/home/%' AND branch_ref LIKE 'omnyadesk/s12/%')
);
CREATE INDEX execution_worktrees_remote_active_idx
 ON execution_worktrees(remote_host,project_id,state)
 WHERE execution_backend='ubuntu_ssh_docker' AND state IN ('allocating','ready');
