-- S15: accommodate descriptive human decision names in the immutable audit history.
ALTER TABLE git_integration_audit ALTER COLUMN action TYPE varchar(24);
