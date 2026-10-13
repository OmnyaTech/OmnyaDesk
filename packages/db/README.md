# PostgreSQL S04 — Migrations e persistência real

A pasta `packages/db/src/` agora contém o executor de migrations e o repositório PostgreSQL. A migration canônica fica em `infra/migrations/001_core.sql`. A API possui modo persistente opcional ativado por `DATABASE_URL`, exclusivo para testes locais antes da autenticação.

**Não executar `infra/sql/001_initial.sql`: é apenas um rascunho histórico.** Não compartilhar credenciais de `.nox/runtime/S04/` e não habilitar Cloudflare Tunnel sobre esta API.

Com o banco já iniciado e `DATABASE_URL` apontando para a instância local:
```sh
pnpm run db:migrate
pnpm run check
pnpm start
```

Consulte [docs/PERSISTENCE.md](../../docs/PERSISTENCE.md) para endpoints, política de migração, testes de reinício e limites.
