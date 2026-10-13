-- S10: Durable per-project scheduler. Separate from S06 worker_jobs until safe execution integration.
CREATE TABLE scheduled_tasks (
 project_id uuid NOT NULL,
 task_id uuid NOT NULL,
 priority smallint NOT NULL DEFAULT 5 CHECK(priority BETWEEN 0 AND 10),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','cancelled')),
 worker_id varchar(100),
 lease_token uuid,
 fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,task_id),
 FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT,
 CHECK((state='running' AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
 OR (state<>'running' AND worker_id IS NULL AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX scheduled_tasks_queue_idx ON scheduled_tasks(project_id,priority DESC,created_at,task_id) WHERE state='queued';
CREATE INDEX scheduled_tasks_running_expiry_idx ON scheduled_tasks(project_id,lease_until) WHERE state='running';

CREATE TABLE scheduled_resources(
 project_id uuid NOT NULL,
 task_id uuid NOT NULL,
 resource_key varchar(270) NOT NULL,
 access_mode varchar(5) NOT NULL CHECK(access_mode IN('read','write')),
 PRIMARY KEY(project_id,task_id,resource_key),
 FOREIGN KEY(project_id,task_id) REFERENCES scheduled_tasks(project_id,task_id) ON DELETE RESTRICT
);
CREATE INDEX scheduled_resources_resource_idx ON scheduled_resources(project_id,resource_key);

CREATE TABLE scheduled_dependencies(
 project_id uuid NOT NULL,
 task_id uuid NOT NULL,
 depends_on uuid NOT NULL,
 PRIMARY KEY(project_id,task_id,depends_on),
 FOREIGN KEY(project_id,task_id) REFERENCES scheduled_tasks(project_id,task_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,depends_on) REFERENCES scheduled_tasks(project_id,task_id) ON DELETE RESTRICT,
 CHECK(task_id<>depends_on)
);
CREATE INDEX scheduled_dependencies_reverse_idx ON scheduled_dependencies(project_id,depends_on);

CREATE TABLE resource_leases(
 project_id uuid NOT NULL,
 task_id uuid NOT NULL,
 resource_key varchar(270) NOT NULL,
 access_mode varchar(5) NOT NULL CHECK(access_mode IN('read','write')),
 fence bigint NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(project_id,task_id,resource_key),
 FOREIGN KEY(project_id,task_id,resource_key) REFERENCES scheduled_resources(project_id,task_id,resource_key) ON DELETE RESTRICT
);
CREATE INDEX resource_leases_overlap_idx ON resource_leases(project_id,resource_key,expires_at);
