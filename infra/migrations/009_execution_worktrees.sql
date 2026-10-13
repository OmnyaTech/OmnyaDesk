-- S12: persistent ownership for per-run Git worktrees.
CREATE TABLE execution_worktrees(
 project_id uuid NOT NULL,
 task_id uuid NOT NULL,
 run_id uuid NOT NULL,
 branch_ref varchar(120) NOT NULL,
 base_sha char(40) NOT NULL CHECK(base_sha ~ '^[a-f0-9]{40}$'),
 checkout_path text NOT NULL CHECK(length(checkout_path) BETWEEN 5 AND 4096),
 state varchar(12) NOT NULL CHECK(state IN('allocating','ready','closed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz,
 PRIMARY KEY(project_id,run_id),
 UNIQUE(project_id,branch_ref),
 UNIQUE(project_id,checkout_path),
 FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT,
 CHECK ((state='closed' AND closed_at IS NOT NULL) OR (state<>'closed' AND closed_at IS NULL))
);
CREATE UNIQUE INDEX execution_worktrees_task_live_idx ON execution_worktrees(project_id,task_id)
 WHERE state IN ('allocating','ready');
CREATE INDEX execution_worktrees_active_idx ON execution_worktrees(project_id,state);
