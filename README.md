# OmnyaDesk

**A local-first, multi-agent developer workspace** — an open-source portfolio project exploring task orchestration, safe tool execution, Git isolation and a future pixel-art office UI.

[![Quality](https://github.com/Yan-Oliv/omnyadesk/actions/workflows/quality.yml/badge.svg)](https://github.com/Yan-Oliv/omnyadesk/actions/workflows/quality.yml)
![Status](https://img.shields.io/badge/status-pre--alpha-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

> **Pre-alpha / engineering prototype.** The task engine and backend foundations are implemented. The interactive pixel-art office, multi-provider AI integration, cloud deployment and full product UX are planned; they are **not** presented as completed features. The software is provided as-is and must not be exposed to the internet without additional security review.

## What's implemented (through S13)

- **Domain and API:** typed contracts, Fastify API, scoped bearer-token authentication, persistent PostgreSQL tasks, transactional FSM, versioned domain events and SSE replay.
- **Orchestration:** durable job queue with bounded retries/leases, task scheduling with resource locks and fencing, MCP ingress and idempotent task intake.
- **Git:** per-task isolated worktrees, serialized integration queue, reviewed candidate hashes and human approval for merge.
- **Tool security:** deny-by-default gateway for a small allowlist of Git, files and tests; compare-and-swap file writes and bounded execution in Docker on a remote **Linux/Ubuntu host over SSH**.
- **Quality:** TypeScript, lint, tests, build, compiled smoke tests, GitHub Actions and a repeatable local development environment.

The pixel-art office and visual multi-agent interaction are part of the [roadmap](docs/BACKLOG.md), not yet a production-ready UI.

## Quick start: public demo (no credentials required)

Requirements: **Node.js 24**, **pnpm 10.18+** (Corepack supported) and Git. On Windows, PowerShell is supported.

```bash
git clone https://github.com/Yan-Oliv/omnyadesk.git
cd omnyadesk
corepack enable
pnpm install --frozen-lockfile
pnpm run dev
```

Open **http://127.0.0.1:4317**. Without `DATABASE_URL`, the app runs its **local in-memory demo**. This mode does not retain data and should never be published to the internet or opened on a public interface.

Run source quality checks without a database:

```bash
pnpm run check
```

Database-dependent integration tests will be skipped without `DATABASE_URL`. For persistent mode, use the next section.

## Persistent local mode: PostgreSQL in Docker

Requirements: Docker Engine / Docker Desktop with Compose. Everything binds **only to localhost**; no production infrastructure or personal SSH keys are needed.

```bash
node scripts/init-local.mjs
docker compose --env-file .env -f infra/docker-compose.yml up -d postgres
node --env-file=.env --experimental-strip-types packages/db/src/migrate-cli.ts
node --env-file=.env --experimental-strip-types apps/api/src/main.ts
```

The setup script creates an **untracked** `.env` with a randomly generated local database password. It refuses to overwrite an existing `.env`. Do not commit that file. API tokens can be generated using the local CLI described in [Authentication](docs/AUTH_API.md). Stop local PostgreSQL with `docker compose --env-file .env -f infra/docker-compose.yml down` (omit `-v` to keep your data).

Run the full test pipeline against this isolated database after exporting `DATABASE_URL` from your local `.env` into the process environment. GitHub Actions uses a disposable PostgreSQL instance.

## Optional: remote Ubuntu sandbox

The Ubuntu execution backend is **opt-in**. By default, cloning this repository does not connect to any server. To use S12/S13 remote tools, you supply **your own** Ubuntu host, SSH agent, host-key fingerprint, Docker installation and private, ignored configuration file. Never copy another developer's server identity, SSH key, Docker socket or database into your setup.

See [Worktrees & sandbox](docs/WORKSPACE_SANDBOX.md) and [Tool gateway](docs/TOOL_GATEWAY.md). Remote test suites intentionally skip when the private SSH configuration is absent; passing the basic CI check does not imply that the remote Docker security tests were run.

## Architecture

```text
apps/api (Fastify, localhost) --- PostgreSQL (tasks, outbox, leases)
  |                                |
  +--- apps/mcp (task ingress)     +--- apps/worker (durable queue)
  |
  +--- safe tools / Git review ---- SSH + Docker (optional Ubuntu host)
                                      |
                                      +--- isolated per-run Git worktree
```

Major modules live in `apps/`, `packages/contracts/`, `packages/db/`, `infra/migrations/` and `tests/`. Architecture and security decisions are documented in [docs](docs/ARCHITECTURE.md) and [ADRs](docs/adr/).

## Segurança / Security

- **No production secrets are part of the repository.** `.env`, credentials, private keys, backups and runtime data are ignored.
- Each published source release is reviewed with a [public-content scanner](scripts/audit-public.mjs). Please never open issues or PRs containing passwords, access tokens or private server addresses.
- The demo is local-only. The SSH/Docker tool controller has privileged access to its own Docker daemon and must not be exposed to untrusted public users. These controls reduce risk but do not create a VM-level security boundary.
- Report sensitive findings privately via [SECURITY.md](SECURITY.md). Do not post exploitable details to a public issue.

## Contributing / Contribuindo

Issues, documentation improvements and small, well-tested pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md). The repository is published as a technical portfolio and open-source prototype under the [MIT License](LICENSE).

---

### Em português

O **OmnyaDesk** é um projeto open source de portfólio para orquestração de agentes de desenvolvimento, com motor transacional, filas, Git isolado e execução limitada de ferramentas. **O escritório visual em pixel art ainda faz parte do planejamento.** Para testar agora, siga o início rápido acima; nenhuma conta ou servidor privado é necessária. Para usar PostgreSQL, o script de instalação cria automaticamente credenciais locais que não são versionadas.

**Status do código publicado:** snapshot técnico aprovado até a S13. Implementações posteriores são publicadas apenas após revisão e testes próprios.
