# S15 — Human review, rejection and rework

The OmnyaDesk local-only Fastify API requires project-scoped bearer tokens. The
Git integration review has three explicit decisions: `approved`, `rejected`,
`changes_requested`. Agents and integration credentials cannot decide, and
the human reviewer must not be the proposal submitter.

## Immutable review

The reviewer obtains the prepared proposal with `GET
/v1/projects/:projectId/git/integrations/:id`. Its `review.diff` is loaded
from the S14 evidence ledger after its SHA-256 hash chain, stored byte sequence,
review hash, target HEAD and tested Git tree have been verified. Approval
requires the exact `reviewHash` for the displayed diff. The reviewer does not
supply or overwrite diff bytes. If the candidate ref or main HEAD changed,
preparation and human review must be repeated.

`POST /v1/projects/:projectId/git/integrations/:id/decide` accepts
`{reviewHash, decision, reason}`, where `reason` is null for approval
and nonblank (up to 2000 chars) for rejection or changes requested.
It requires the `git:review` scope and a human token from a different subject
than the submitter. Decisions and reviewer identity are saved atomically to
the proposal state, append-only Git audit and SHA-256 evidence ledger.

`approved` allows the existing S11 serialized Git integration queue to merge
only the exact previously tested tree via atomic ref CAS. `rejected` is
terminal for the proposal; it cannot be approved, integrated or reopened.
`changes_requested` blocks integration until the original submitter uses
`POST /v1/projects/:projectId/git/integrations/:id/resubmit` with
`{candidateRef,candidateSha,baseSha,expectedRevision}`. A different commit is
required, the revision increments, old approval is reset, and `prepare`
must produce new review evidence and new human approval. Old evidence and
decision audit remain append-only.

## Atomic task decision

`POST /v1/projects/:projectId/tasks/:taskId/human-decisions` requires BOTH
`git:review` and `tasks:transition` scopes on a human bearer. The strictly
validated payload is
`{integrationId, commandKey, expectedVersion, reviewHash, decision, reason}`.
In one PostgreSQL transaction the service locks the Git integration proposal,
rechecks token validity and project/task ownership, verifies the unchanged
diff and candidate, records the human decision, transitions the task and
appends its event/outbox message. Failures (including stale task version)
roll back **all** operations: no partial approval.

Outcomes map to task states as follows: approval -> `approved`, rejection ->
terminal `cancelled`, changes requested -> `changes_requested`. The latter
may be requeued with a **new** task run, while the Git resubmission still
requires a new candidate and fresh review. The general task transition API
continues to prohibit direct `approved` and `changes_requested` changes.
This separation means agent/service transitions cannot silently approve.

A decision key is not accepted twice as a second review. Retries of already
completed decisions return conflict rather than creating another audit record;
clients should GET current state and review evidence before retrying a
command. No role, token or decision is inferred from a user-supplied JSON
actor field.

## Security and operational limits

This sprint runs locally and does not deploy public API, Cloudflare tunnel or
change other products' Docker stacks. API request size, scope, database
constraints, immutable evidence chain and audit rules remain enforced.
The controller and PostgreSQL database administrator are still trusted:
a PostgreSQL superuser could bypass triggers; a cryptographically anchored,
off-host/WORM archive is not included. Docker sandbox shares the Ubuntu
host kernel. Human review UX/dashboard remains a later planned sprint; S15
exposes review through authenticated API endpoints with OpenAPI schemas.

For validation, run `pnpm run check`, including disposable PostgreSQL and
the explicit real Ubuntu test configuration. S15 tests cover denial by
integration actors, stale hashes, candidate changes, rejected proposals,
rework revision/candidate enforcement, HTTP scopes, transaction rollback,
event/outbox integrity and S11 regression.
