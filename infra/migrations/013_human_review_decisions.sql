-- S15: human decisions on exact immutable diff versions with explicit rework cycle.
ALTER TABLE git_integration_requests DROP CONSTRAINT git_integration_requests_state_check;
ALTER TABLE git_integration_requests ADD CONSTRAINT git_integration_requests_state_check
 CHECK(state IN ('queued','ready','conflict','tests_failed','stale','merged','rejected','changes_requested'));
ALTER TABLE git_integration_requests
 ADD COLUMN decision_state varchar(20) NOT NULL DEFAULT 'pending'
  CHECK(decision_state IN ('pending','approved','rejected','changes_requested')),
 ADD COLUMN decision_by uuid,
 ADD COLUMN decision_at timestamptz,
 ADD COLUMN decision_reason varchar(2000),
 ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 ADD CONSTRAINT git_review_decision_consistent CHECK(
  (decision_state='pending' AND decision_by IS NULL AND decision_at IS NULL AND decision_reason IS NULL)
  OR (decision_state='approved' AND decision_by IS NOT NULL AND decision_at IS NOT NULL
       AND approved_by=decision_by AND approved_at IS NOT NULL AND decision_reason IS NULL)
  OR (decision_state IN('rejected','changes_requested') AND decision_by IS NOT NULL
       AND decision_at IS NOT NULL AND decision_reason IS NOT NULL AND
       approved_by IS NULL AND approved_at IS NULL)
 );
ALTER TABLE git_integration_audit DROP CONSTRAINT git_integration_audit_action_check;
ALTER TABLE git_integration_audit ADD CONSTRAINT git_integration_audit_action_check
 CHECK(action IN('submitted','prepared','blocked','approved','stale','merged','rejected','changes_requested','resubmitted'));
ALTER TABLE evidence_entries DROP CONSTRAINT evidence_entries_kind_check;
ALTER TABLE evidence_entries ADD CONSTRAINT evidence_entries_kind_check
 CHECK(kind IN ('log','diff','artifact','review_diff','review_approval','review_decision'));
-- Backfill pre-S15 human approvals without forging a new audit decision.
UPDATE git_integration_requests SET decision_state='approved', decision_by=approved_by,
 decision_at=approved_at WHERE approved_by IS NOT NULL AND approved_at IS NOT NULL;
CREATE INDEX git_review_decision_idx ON git_integration_requests(project_id,task_id,decision_state);
