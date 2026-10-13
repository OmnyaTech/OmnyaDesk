# S04 — Persistência PostgreSQL (ambiente local)

**Estado:** implementado e testado contra uma instância PostgreSQL real, isolada no developer-workstation. **Não é ambiente de produção.**

## Escopo

- `infra/migrations/001_core.sql`: migration inicial para `projects`, `offices`, `tasks`, `task_events`. Chaves estrangeiras vinculam o escritório e a tarefa ao mesmo projeto. Status, versão, UUID, limites de campos e payload JSON possuem constraints no banco.
- `packages/db/src/migrations.ts`: executor transacional, com lock advisory e checksum SHA-256 para impedir alteração silenciosa de migrations já aplicadas. `schema_migrations` registra o histórico.
- `packages/db/src/repository.ts`: repositório de projetos, escritório padrão, tarefas e envelopes de eventos V1. A criação de tarefa e de `task.created` ocorre numa mesma transação. Queries parametrizadas.
- `apps/api/src/persistent.ts`: endpoints de prova de integração com PostgreSQL (somente loopback). O estado do mock NÃO é transferido automaticamente para o banco.
- `tests/postgres.test.ts`: idempotência das migrations, persistência após reconexão, rollback de erro de FK, imutabilidade e constraints. Esses testes executam quando `DATABASE_URL` está presente.
- `.github/workflows/quality.yml`: PostgreSQL efêmero de CI, migration + `pnpm run check`. Execução do GitHub Actions **ainda não ocorreu** (sem remote Git).

## Configuração local (NÃO usar em produção)

Foi inicializado um cluster PostgreSQL próprio em `.nox/runtime/S04/` (fora do repositório Git), vinculado a `127.0.0.1`, com autenticação SCRAM para TCP. A porta é alocada dinamicamente e os dados permanecem no disco. Nunca publicar essa porta na WAN ou em um Cloudflare Tunnel.

Os arquivos `db-config.json`, `pw.secret` e `pgdata/` contêm dados ou credenciais e **não** devem ser copiados para o repositório, anexados em tarefas ou incluídos em commits, prints e logs.

PowerShell (na pasta de código do OmnyaDesk; ajuste o caminho do Nox se necessário):

```powershell
$cfg = Get-Content -LiteralPath "..\..\.nox\runtime\S04\db-config.json" -Raw | ConvertFrom-Json
$env:DATABASE_URL = $cfg.connectionString
pnpm run db:migrate
pnpm run check
pnpm run build
pnpm start
```

Com `DATABASE_URL` ausente, a API continua no modo mock usado nas sprints S01–S03. Com o banco habilitado, endpoints de tarefas/eventos legados retornam HTTP 409 para evitar misturar dados de demonstração e dados persistidos.

### API PostgreSQL local

| Verbo | Rota | Operação |
|---|---|---|
| GET | `/v1/status` | Estado `persistent-postgres` |
| GET | `/v1/projects` | Listar projetos (uso local de teste) |
| POST | `/v1/projects` | Criar projeto e escritório padrão atomicamente |
| GET | `/v1/projects/:id/tasks` | Listar tarefas reais do projeto |
| POST | `/v1/projects/:id/tasks` | Criar tarefa e `task.created` numa transação |
| GET | `/v1/projects/:id/events?after=N` | Consultar eventos V1 com cursor |

Exemplo de criação de projeto (identidades UUID são de teste, não tokens de autenticação):

```json
{
  "ownerId": "ce4e0a22-0d90-4a1f-8ff3-3f584bcfbe21",
  "name": "Projeto de teste",
  "repositoryRoot": null,
  "template": "startup"
}
```

O POST da tarefa recebe `officeId`, `requestedBy`, `title`, `description`. Nada é executado por agentes reais na S04. O estado inicial da tarefa permanece `created`; transições, idempotência de comandos e outbox serão implementadas na S05.

**Atenção:** a API ainda não autentica o operador. UUIDs são apenas identificadores. Mesmo o modo persistente **não pode ser publicado externamente** até a S07 e a revisão de segurança.

## Evidência e retomada

`.nox/evidence/S04/restart-smoke.json` registra criação de projeto/tarefa/evento pela API compilada e sua recuperação após reiniciar tanto o processo da API quanto a instância PostgreSQL. A evidência não inclui segredos nem conteúdo pessoal.

A instância da S04 pode ser iniciada com `pg_ctl` usando `cfg.dataDir`, `cfg.log` e `cfg.port` obtidos do arquivo privado. Nunca executar `initdb` novamente sobre diretório existente. Não limpar `.nox/runtime/S04/pgdata` sem backup e confirmação explícita.

## Limites / próximos gates

S05: transições de estado, concorrência otimista, outbox e idempotência; S06: fila/worker; S07: autenticação/autorização; S08: streaming persistente e replay SSE; S28–S29: Docker próprio no servidor, Cloudflare Tunnel + Access. O esquema simplificado da S04 é versionado e evoluirá em migrations aditivas nas próximas sprints. Não editar `001_core.sql` depois de aplicado; criar `002_*.sql`.

`infra/sql/001_initial.sql` é um rascunho anterior e não foi executado nem deve ser aplicado. Somente `infra/migrations/*.sql` é canônico.

**Portabilidade de migrations:** SQL recebe final de linha LF via `.gitattributes`; checksums SHA-256 normalizam CRLF para LF antes da comparação. Esta proteção foi validada em clone limpo no Windows após uma falha de checksum detectada pela migração. Mudanças semânticas no conteúdo continuam rejeitadas e devem usar nova migration.
