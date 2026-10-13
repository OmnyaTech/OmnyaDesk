# S16 — Provider adapter contract and deterministic mock

OmnyaDesk defines one **provider-neutral** API in
`packages/contracts/src/provider.ts`, exported from the public contract
entrypoint. The only implementation in this sprint is
`packages/adapters/src/mock.ts`, a deterministic in-process fake. There are
**no external LLM calls**, vendor accounts, tokens, shell execution or Docker
mutations in the mock. Real provider integration is the separate S17 scope.

## Contract

`AgentProvider` requires `id`, `stream(request,signal)`, and
`run(request,signal)`. `run` uses the same shared
`executeProvider` collector as any future adapter. Both accept an
`AbortSignal`; `executeProvider` optionally forwards validated events
to a consumer callback. Runtime validation uses strict Zod schemas:

- `AgentExecutionRequestSchema`: project/task/run UUIDs, agent role,
  sandbox identity, worktree path, model ID, requested tool identifiers,
  prompt, max steps and monetary budget. Tool identifiers are **descriptive
  metadata only**: they never grant tool access.
- `AgentProviderEventSchema`: envelope v1, provider/project/task/run
  identity, monotonic sequence and events `started`, `delta`,
  `completed`, `cancelled`, `failed`.
- `AgentExecutionResultSchema`: exact concatenated output, bounded
  artifact descriptors (safe relative paths + SHA-256) and nonnegative usage.
  Mock reports zero tokens and zero USD because it consumes no model.
- `executeProvider` validates ordering, identity, start and terminal
  events, output limits, max steps, budget, and payload equality; it rejects
  malformed or malicious events rather than treating provider output as
  trusted. No task approval is implied by any provider response.

Events are streamed via `AsyncIterable` with natural pull-based
backpressure. Completion is a single typed terminal event. A cancelled
execution emits `cancelled` (including an already aborted signal or abort
during a simulated delay), then terminates with an `AbortError` for
`run`. Abort listeners and timers are cleaned up. Cancellation is
**cooperative**: it cannot roll back effects of a real provider; S16 performs
none. Long-lived connections, retry policy, token quotas and external usage
will be specified in S17 before enabling any real integration.

## Scenarios and failure injection

`new MockProvider({chunks:['one','two'],delayMs:5,failAtChunk:1})` emits a
start, the first delta, then a controlled `MOCK_FAILURE`.
`delayMs` is bounded to 0..2000 ms; chunks are bounded and never derived
from or echo the sensitive prompt. If `maxSteps` is exhausted the mock
emits `QUOTA_EXCEEDED`, not an over-budget completion.

The mock **never runs tools** even if `allowedTools` lists identifiers.
It never reads `workspacePath`, never persists task data, and never
connects to the network. A mock completion does not change the task FSM,
commit Git, authorize a human approval, or create billable cost.

## Reproducible validation

Use `node --experimental-strip-types --test tests/provider-mock.test.ts`
for contract and adversarial cases, then `pnpm run build` followed by
`pnpm run smoke:provider` for nine compiled checks. `pnpm run check`
runs the S16 smoke after all previous backend, security and Ubuntu Server
smokes. S16 can be validated locally with no external provider token.
The full Nox acceptance also requires a clean independent offline clone,
public source-secret audit + Gitleaks and successful public GitHub Actions.

Public CI uses disposable PostgreSQL. Existing remote Ubuntu test gates
remain mandatory in the private clean checkout and opt-in for public CI.

## Next stage

S17 must implement a real adapter **behind this same interface**, using
an authorized isolated worktree, external credential handling, quotas,
fencing/lease checks, audit and cancellation; it cannot bypass S15 review
or S12/S13 tool allowlists. The mock is a simulation, not a production AI
provider.
