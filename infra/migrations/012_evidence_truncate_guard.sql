-- S14: disallow TRUNCATE, which skips row-level DELETE triggers.
CREATE TRIGGER evidence_entries_no_truncate BEFORE TRUNCATE ON evidence_entries
 FOR EACH STATEMENT EXECUTE FUNCTION enforce_evidence_append_only();
