# S19 — Four-role resilience, isolation and recovery

S19 extends the S18 provider-neutral four-role pipeline with cumulative
budgets, an abortable deadline, an operator kill switch, and tightly bounded
retry handling. S17 (real Codex) and S18 (real four-role integration) are both
completed and verified separately.

## Trust boundary

`MockResilienceController` defaults to **mock-only**. In a separately
authorized *local test runner*, the optional `isolated-codex` mode requires
all of:

- `OMNYA_S19_ISOLATED_GUEST=1`, Linux Docker runtime, and a canonical S12
  project/run workspace bind mounted `ro` according to `/proc/self/mountinfo`
- A physical S12 read-only checkout plus S10 fenced task lease; a trusted
  adapter maps four logical stage IDs back to that one authorized checkout
- `provider.id==='codex'`, no model tools, a strict per-stage contract and
  global `maxRetries=0`; the real provider must still independently enforce
  the S17 read-only Docker workspace and authentication guard
- A dedicated resource-restricted Node 22 container (pinned by SHA-256,
  `--read-only`, `--cap-drop ALL`, no-new-privileges, bounded memory/pids,
  and only a read-only worktree/Git source mount)

The S19 real-mode flag is a **local trust assertion**, not an authorization
protocol for untrusted HTTP callers. Do not make it available through user
requests or rely on `provider.id` alone as proof of provider identity.

## Limits and failure semantics

`ResiliencePolicySchema` bounds global wall-clock time, cumulative
reported input/output tokens, number of delta events, cumulative estimated
USD, retries and exponential backoff. Usage and estimated cost are checked
**at stage completion**, before any downstream stage. A budget failure never
returns a completed pipeline or persists an approval receipt.

A real token/cost estimate is **not a hard billing or token-prepayment cap**:
provider calls can consume tokens before the final usage report is available.
Real retries are disabled to avoid replaying a non-idempotent operation;
bounded exponential retries apply only to the deterministic tool-free mock,
before any partial output and only for `PROVIDER_ERROR`. Quota failures,
post-output failures, protocol violations and cancellations are never retried.

`controller.kill()` and caller AbortSignal cancel cooperative streams,
backoff and independent checks. Non-cooperative JavaScript promises are
raced against cancellation; telemetry observers cannot disable a stop.
**Hard process cancellation** is a separate host-side safeguard: the trusted
S19 runner first verifies exact S19 container name and both ownership labels,
then runs `docker rm -f` on that *one disposable container only*. The test
requires a nonzero process exit, clean worktree and no approval or Git merge.
No Docker daemon restart, global network, firewall or IPv6 changes are needed.

The S15 human review boundary is unchanged: even a fully successful real
pipeline returns `awaiting_human_approval` with `gitIntegrated=false`.

## Opt-in live tests (private, never CI)

`scripts/smoke-s19-live.mjs` requires `OMNYA_S19_LIVE=1`, a private pinned
S12 SSH config, PostgreSQL and the operator-supplied S17 runtime root.
Its required `OMNYA_S19_MODE` is one of:

- `budget`: make the global token budget one token; a real Architect
  invocation must stop with `TOKEN_BUDGET_EXCEEDED` before Developer
- `kill`: verify exact ownership of an executing disposable S19 Docker
  container, forcibly terminate it and ensure no successful completion or
  Git mutation
- `success`: run the whole four-role Codex pipeline under the S19 cumulative
  limits; record nonzero usage, chained hashes, two independent synthetic
  verifier receipts, and S14 ledger verification while requiring S15 approval

Every mode creates and cleans its own task/lease/worktree and emits
**content-free receipts only**. Prompt, credentials and model output remain
inside the trusted, temporary guest. The separate QA and reviewer processes
check a synthetic fixture and cryptographic provenance; they are not humans
and are not comprehensive QA of a production patch.

## Reproducibility and release

`tests/resilience.test.ts` includes adversarial provider/retry/identity/
timeout/cancellation/concurrency and disposable real Git tests. Compiled
`smoke:resilience` remains part of `pnpm run check`; real pilots are opt-in
and excluded from public CI. Full release also requires frozen independent
checkout with migrations, Gitleaks over source/history, sanitization and
public GitHub Actions SUCCESS on the exact published commit.

**Production safety:** never alter host IPv6, Docker global networking,
firewall, OmnyaLog or other production containers. This sprint does not
approve automatic merges, deployments, paid API keys or plan upgrades.
