-- S27: binary data is private in PostgreSQL, never inside public/static directories.
-- Immutable task-scoped attachments, 1 MiB hard cap, SHA-256 audit reference.
CREATE TABLE task_attachments (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL,
 task_id uuid NOT NULL,
 uploaded_by uuid NOT NULL,
 filename varchar(120) NOT NULL,
 mime_type varchar(60) NOT NULL CHECK (mime_type IN (
  'image/png','image/jpeg','application/pdf','text/plain','text/x-diff')),
 data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 1048576),
 size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
 sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE RESTRICT,
 CHECK (octet_length(data)=size_bytes),
 CHECK (char_length(filename)>0)
);
CREATE INDEX task_attachments_task_idx ON task_attachments(project_id,task_id,created_at DESC,id DESC);
CREATE INDEX task_attachments_project_idx ON task_attachments(project_id);
CREATE FUNCTION prevent_task_attachment_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Attachments are append-only';
END;
$$;
CREATE TRIGGER task_attachments_immutable
BEFORE UPDATE OR DELETE ON task_attachments FOR EACH ROW
EXECUTE FUNCTION prevent_task_attachment_mutation();
