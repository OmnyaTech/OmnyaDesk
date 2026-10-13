# Security Policy

OmnyaDesk is a **pre-alpha, local-first prototype**. It is not certified, audited for deployment as a public service, or designed to accept untrusted internet requests in its current state.

## Supported versions

Only the latest `main` branch is receiving prototype maintenance. No stable release or security update commitment is offered.

## Reporting privately

If you discover a vulnerability, **do not include exploitation details, credentials or private infrastructure identifiers in a public issue**. Use GitHub's **Report a vulnerability** / private vulnerability reporting feature if enabled, or contact the repository maintainer privately through their GitHub profile.

Never submit actual API tokens, private keys, passwords, database dumps, personal information or server configuration. Test with disposable projects and synthetic data.

## Security boundaries

- In-memory demo binds to loopback and is unauthenticated.
- Persistent Fastify API has scoped bearer-token auth and binds to localhost; no public reverse proxy is configured.
- Optional SSH/Docker operations execute on a developer-owned Ubuntu host; Docker containers share the host kernel, and the controller has privileged Docker capabilities.
- File tool writes are limited and version-checked, but a lease revoked concurrently with a completed write may not roll back that write.

Review the source and configure additional isolation before use beyond local experiments.
