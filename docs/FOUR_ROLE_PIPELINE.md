# S18 — Four-role pipeline (mock + validated isolated Codex pilot)

## Pipeline and trust boundaries

S18 adds `packages/pipeline/src/four-role.ts`, a provider-neutral orchestration
for `architect -> developer -> qa -> reviewer`. Each stage receives its own
unique `runId`, a distinct agent actor identity, a strictly bounded model
prompt and the prior stage's output labelled **untrusted**. The reviewer can
inspect both developer and QA text. The same project/task/pipeline identity is
preserved; stage identities must be unique. No tools are authorized and no
workspace or Git mutation occurs through the mock.

Stage inputs and provider responses are schema-validated. External checks are
required to move past QA and reviewer, even if a model claims "APPROVED":

* **QA:** a trusted caller-supplied `external_test_runner` must attest the
  **developer output SHA-256**, with a separate examiner ID and report hash.
  Self-approval, stale hashes, rejection, invalid attestation and verifier
  outages fail closed.
* **Review:** a different `independent_reviewer` must attest the reviewer's
  output hash. It cannot reuse any agent identity or the QA examiner identity.
  The model's own opinion cannot bypass that external check.
* Stage receipts form a SHA-256 chain and contain output digests, event roles,
  immutable run IDs and estimated usage — **not raw text or secrets**.
* A successful four-role sequence returns
  `status='awaiting_human_approval'`,
  `humanApprovalRequired=true`, `gitIntegrated=false`. Neither the model,
  the QA examiner nor the independent review gate authorizes S15 human approval,
  Git merge, or a task FSM transition. S15 remains the sole authority.

`qaCheck` and `reviewerCheck` are injected **trusted callbacks** and do
not run external tests by themselves. Mock unit/smoke tests use deterministic
test doubles; they are not evidence of independent human review, live Codex
inference, a successful PR integration or a production task. A future live
runner must enforce signed/verifiable authorization for these callbacks and
record persistent S14 receipts tied to a genuine S10/S12 run.

## Validation

* `node --experimental-strip-types --test tests/four-role-pipeline.test.ts`:
  15 adversarial scenarios including order, budgets, identity isolation,
  failure at developer, QA rejection, reviewer denial, prompt handoff and
  cancellation.
* `pnpm run build && pnpm run smoke:four-role`: compiled deterministic
  four-role gate and negative QA proof.
* `pnpm run check` includes the S18 smoke after all previous tests and
  Ubuntu Server S12/S13 smokes.
* S18 began as a mock-only implementation while S17 validation was pending.
  After S17 completion, a separate authorized four-role Codex pilot verified
  all real stage streams; CI itself remains free of private credentials.

## Non-negotiable dependency before final release

S17 is COMPLETED and its authorized real Codex pilot and public CI passed.
S18's independently executed **real** integrated pilot is available only by
explicit opt-in `OMNYA_S18_LIVE=1` with the pinned S12 SSH configuration,
PostgreSQL and operator-provided `OMNYA_S17_RUNTIME_ROOT`. The pilot:

- Claims an S10 fenced lease, provisions one canonical S12 disposable Git
  worktree, launches **four sequential real Codex calls** in a constrained
  Docker container with a read-only Git bind mount. Each pipeline stage has a
  distinct logical run ID while only a trusted adapter maps it to the single
  approved physical S12 workspace and returns identity-matched events.
- Runs a **separate Node.js verifier process** for QA on the developer output
  and a distinct verifier for the reviewer output. These independently check
  fixture content, semantic sentinel, risk disclosure and SHA-256 provenance;
  neither is a human approval, production code QA, or authority to merge.
- Fails closed on missing stages, invalid stream/usage, inconsistent digests,
  denied external attestations, estimated total exceeding the synthetic
  limit, dirty Git worktree or any accidental Git integration/autoapproval.
- Stores content-free chained receipts in the S14 ledger and cleans the
  Docker container, S12 worktree and request fixture.

The real 2026-10-13 test passed: four roles each produced streamed
started/delta/completed events and nonzero usage; the independently executed
QA and reviewer verifiers passed; S14 chained evidence was persisted and
verified; `status=awaiting_human_approval`, `gitIntegrated=false`. Total
reported use: 54,721 input tokens and 1,133 output tokens. Estimated usage
USD 0.081834 (operator sample rates, **not billed amount**).

Security limits: `scripts/smoke-s18-live.mjs` is a **private opt-in pilot**
never called from CI or `pnpm check`. Model tools and network access through
model sandbox remain disabled, though the trusted runtime needs outbound
network to contact Codex. A single physical worktree does not authorize
writing, Git merge, deployment or S15 approval. The callbacks are isolated
automated checks rather than human approval or comprehensive integration
tests of generated application code. S19 effectful-provider cancellation,
operational hard process kill and billed spend caps are separate requirements.

No paid API keys, host IPv6 changes, Docker network reloads, Cloudflare
changes or OmnyaLog restarts are required.
