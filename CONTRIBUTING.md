# Contributing to OmnyaDesk

Thank you for your interest! This project is a pre-alpha developer workspace and portfolio.

1. Open an issue describing the change before starting a substantial feature.
2. Never submit credentials, private hostnames/IPs, proprietary source, real customer data, or test fixtures containing secrets.
3. Create a feature branch, install with `pnpm install --frozen-lockfile`, and run `pnpm run check`.
4. If changing persistent data, add a **new** numbered SQL migration; do not edit applied migrations.
5. Add unit and integration tests for security or workflow changes. PostgreSQL/remote Ubuntu tests require your own disposable setup.
6. Open a PR explaining behavior, impact, tests and any security tradeoffs.

**Do not run tool-execution tests against repositories or Docker hosts you cannot afford to lose.** The project is not yet production ready.

See [SECURITY.md](SECURITY.md) for sensitive reports and [LICENSE](LICENSE) for reuse rights.
