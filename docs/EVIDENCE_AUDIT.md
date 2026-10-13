# S14 — Evidências e auditoria

OmnyaDesk records bounded, versioned evidence per project/task/run in PostgreSQL.
Migrations `011_evidence_audit.sql` and `012_evidence_truncate_guard.sql`
extend the existing schema without changing other applications or Docker stacks.

## Immutable ledger

`EvidenceLedger.append()` serializes writers by logical scope inside a database
transaction. The trigger rejects invalid digests, out-of-order versions, wrong
parent chains, inconsistent run ownership, UPDATE/DELETE and TRUNCATE.
Each version stores immutable UTF-8 content (maximum 64 KiB), a SHA-256 payload
digest, the previous chain digest and a SHA-256 chain digest over project,
task, kind, scope, version, metadata, run and actor. `read()`, `list()` and
`verify()` validate the complete scope chain before returning evidence.
The database provides scope isolation and does not expose public artifact URLs.

The S13 Ubuntu SSH tool gateway writes audit receipts for completed operations
after its lease/fencing authorization checks: log for status, file read/list
and test output, diff for Git patches, artifact for file writes. File read/list
receipts contain a checksum only; file content and SSH/lease credentials are
not copied into receipt metadata. The CLI returns the immutable evidence ID,
version and content digest. Failed authorization does not create a success
receipt. Operational logs must never be committed to the public repository.

## Git review binding

S11 `prepare()` persists the exact Git diff bytes and digest, target HEAD,
tested tree, planned commit and review hash in the same transaction as the
integration proposal. `get()` returns the validated immutable diff for
presentation to the reviewer. `approve()` requires a distinct human token and
the exact hash, verifies the stored bytes against the Git objects and creates
an approval evidence entry tied to the reviewed version. `integrate()`
verifies the review again before atomic Git ref CAS. A stale base requires a
new preparation and a new human approval; older review evidence remains intact.

## Security boundary and limitations

This is an append-only **application/database-owner controlled** history, not a
tamper-proof independent forensic archive. A database administrator or an
attacker with sufficient DDL/superuser privileges can disable triggers,
rewrite/delete evidence, or erase the database. A deleted suffix of a hash
chain cannot be detected without an external checkpoint. Durable off-host
anchors, WAL/archive retention, signed attestation, granular roles and
disaster recovery require further implementation and operational controls.

Large/binary artifacts are intentionally rejected rather than stored as
unbounded bytea blobs. Later versions may use immutable object storage with
separate retention and integrity verification. This sprint does not make
Ubuntu Docker isolation equivalent to a VM nor expose the prototype on the
public internet.

## Verification

Run `pnpm run check` with disposable PostgreSQL and explicit SSH test
credentials for optional real Ubuntu smoke tests. S14 tests cover concurrency,
hash verification after DB reconnection, illegal mutation attempts, malformed
payloads, cross-project reads, run capture and Git diff-to-approval binding.
Do not mark S14 completed on lint/build success alone: require the clean
checkout, smoke and QA gates plus full review.
