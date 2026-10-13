# S17 — Real Codex provider pilot (not yet approved)

## Purpose and current status

S17 introduces an SDK-based `CodexProvider` adapter using
`@openai/codex-sdk@0.162.1`, pinned in `pnpm-lock.yaml`.
Its stream receives SDK `item.updated` / `item.completed` and
`turn.completed` events, transforms message deltas into S16 event envelopes,
and reports input/output tokens and **estimated** USD using explicit
operator-provided per-million-token rates.

The actual invoice and account/subscription billing are **not exposed by the
SDK**. The estimated amount is not a prepaid limit, an exact charge, or a
guarantee against exceeding `maxCostUsd`; the limit is evaluated at
`turn.completed`. Use the plan's provider usage limits and a single tiny
sandbox-only read-only turn for the S17 pilot. Do not use a metered API key
without separate authorization from the operator.

## Trust boundary

- Production `CodexProvider` uses `assertCodexDockerSandbox`: Linux,
  real Docker container, the exact
  `/home/<operator>/.local/share/omnyadesk/s12/projects/<projectId>/<runId>/workspace`
  path, `/.git`, and a **read-only bind mount** confirmed by mountinfo.
  Caller cannot choose an alternate project, symlink escape or sandbox ID.
- S17 pilot only supports `allowedTools=[]`, `maxSteps<=32`,
  `sandboxMode=read-only`, approval policy `never`, no extra directories,
  web-search disabled and sandboxed tool-network access disabled. SDK
  `max_turns=1`; no writing, Git merge, deployment, tool grants or
  human approval is performed by the adapter.
- The operator must start the container with read-only worktree/source.git,
  `--cap-drop ALL`, `no-new-privileges`, resource quotas and an independent
  authentication state outside every Git repository.
- The S14 `CodexEvidenceRecorder` stores a hash of each delta/final output,
  event types/counts and token usage; **no raw model response, prompt,
  credentials or authentication files** are placed in Git or evidence logs.
- A real runner must first verify S10 scheduler lease/fence and S12 worktree
  ownership. The current SDK adapter alone is not a worker or an
  authorization service. Approval and integration remain exclusively S15.

## Ubuntu runtime installation

On the Ubuntu host, the isolated, unprivileged runtime lives under
`~/.local/share/omnyadesk/s17/`. The current development environment
prepared a pinned Docker `node:22-bookworm-slim` image digest
`sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`
and npm packages `@openai/codex@0.162.1`, `@openai/codex-sdk@0.162.1`,
`zod@4.6.6`, `pg@8.23.1`. These are free to install; inference access is
separate and must not create an unauthorized charge.

The **account holder** must perform device-code login through the secured
Ubuntu container (not Windows and not WSL). Do not share the device code
with the assistant; do not upload or copy `auth.json`, environment API keys
or tokens. The Ubuntu script at
`/home/<operator>/.local/share/omnyadesk/s17/authorize-ubuntu.sh`
runs the authentication flow without exporting credentials to the workspace.
After authentication, it is necessary to verify that the device-login is
active, prepare a Git-only disposable source satisfying S12 restrictions,
mount it read-only into Docker, test permissions and produce a real
SHA-256 chained usage/evidence receipt (not an externally signed attestation). No one should call S17 completed before then.

## Evidence and release gates

Unit-only adversarial tests: `tests/codex-provider.test.ts`.
They inject simulated SDK events and prove streaming, abort, strict workspace
contract and estimates **without model use**.
They are not evidence of a real provider call.

Live acceptance requires a disposable Git repo/worktree, short real Codex
turn with non-sensitive input, event stream, token usage, estimated cost,
failed unauthorized shell/path probes, S14 ledger receipt tied to
project/task/run, cleanup, full suite without skips, independent clean clone,
Gitleaks and public GitHub Actions success. Do not publish internal login
state, runtime folders, or credentials to the public portfolio.

The S17 live pilot was revalidated on 2026-10-13 with the ChatGPT-authenticated
Codex default model and **PASS**: a synthetic request streamed started/delta/
completed, reported 11,873 input tokens, 30 output tokens and US$ 0.023986
**estimated** usage (not a bill). The SHA-256 evidence receipt was persisted
and verified in the S14 ledger, linked to project/task/run; all disposable
worktree and container resources were cleaned up. The original plan quota
block was temporary. No purchased API credits or account upgrade were used.

The trusted Linux operator must supply `OMNYA_S17_APPROVED_WORKSPACE_ROOT`
(e.g. `/home/<operator>/.local/share/omnyadesk/s12/projects`) inside the
Docker runner, and `OMNYA_S17_RUNTIME_ROOT` (the matching S17 runtime root)
when running the opt-in Windows-side pilot. Only a bounded home-directory
worktree root is accepted; the worktree itself must be an exact, read-only
Docker bind mount. No username or server-specific path is embedded in the
public implementation. This acceptance does **not** automatically approve
S18 multiagent live integration or bypass S15 human review.

The opt-in `scripts/smoke-codex-live.mjs` creates a disposable, scoped S12
worktree and scheduler lease, mounts Git read-only with a pinned Docker image,
requests a tiny synthetic prompt through the logged-in Codex SDK, and verifies
run identity, event order, usage, read-only checkout, chained evidence and
cleanup. It is deliberately excluded from public CI and `pnpm check`.
A usage-limit rejection yields `QUOTA_EXCEEDED` and cannot be accepted as PASS.
