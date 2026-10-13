# S07 — API Fastify/OpenAPI com autenticação local

**Estado:** Implementada e testada com PostgreSQL local. **NÃO liberar na internet.**

## 1. Arquitetura

Dois itens desta sprint: **Fastify/OpenAPI** e **tokens/escopos por operação**. Quando `DATABASE_URL` está definida, `apps/api/src/main.ts` sobe apenas `apps/api/src/server.ts` (Fastify), sem montar endpoints legados mock. Quando não está, o protótipo S01–S06 continua em localhost e **não representa dados persistidos**.

- Migrations `004_local_tokens.sql`: tokens por `project_id` e `subject_id`, `human` ou `integration`, escopos validados, hash SHA-256 do segredo, validade, revogação e índices.
- `packages/db/src/tokens.ts`: emissão local de token aleatório de 256 bits, acesso por hash, vencimento, revogação. O segredo em texto claro é exibido **apenas uma vez** na CLI do operador, não é salvo no banco nem deve ser registrado em logs.
- `apps/api/src/server.ts`: rotas Fastify com JSON schemas estritos e especificação OpenAPI gerada em `GET /openapi.json`. `onRequest` autentica por padrão todas as rotas `/v1/` com exceção de `/v1/status`. A verificação de escopo e projeto ocorre no servidor, em cada operação.
- O HTTP permanece exclusivamente em `127.0.0.1` ou `::1`; tentativa de bind em `0.0.0.0` é recusada mesmo com token.
- O campo `requestedBy` em criação de tarefa vem exclusivamente da identidade do token. O corpo não pode escolher outro usuário; propriedades extras falham em validação.
- O modo PostgreSQL não atende os caminhos `/api/tasks`, `/api/events` ou aprovação legada sem autenticação.

## 2. Escopos

| Escopo | Operações |
|---|---|
| `projects:read` | `GET /v1/projects` (somente projeto associado ao token); `GET /v1/projects/:projectId` |
| `tasks:read` | `GET /v1/projects/:projectId/tasks` |
| `tasks:create` | `POST /v1/projects/:projectId/tasks` |
| `tasks:transition` | `POST /v1/projects/:projectId/tasks/:taskId/transitions`, exceto aprovação/rejeição humana |
| `events:read` | `GET /v1/projects/:projectId/events` e `GET /v1/projects/:projectId/outbox` |

Respostas: `401` sem token/ inválido/ expirado/ revogado; `403` sem escopo ou tentativa de aprovação; `404` para projeto diferente (sem permitir enumeração de projeto); `400` corpo/parametros inválidos; `409` conflito de estado ou FK.

**Importante:** os esquemas não implementam RBAC multi-tenant nem login OAuth; são **credenciais locais de API**. Tokens não podem criar outros tokens pela rede. Sem aprovação humana HTTP até S15, que deverá verificar revisão do diff, run e identidade efetivamente autenticada. **S07 não é a autorização final para trabalho de agentes externos ou deploy público.**

## 3. Bootstrap local do projeto e credenciais

É necessário fornecer `DATABASE_URL` via ambiente do processo local, apontando para a instância PostgreSQL dedicada. NÃO colar URLs/segredos no chat, CI ou Git.

```powershell
pnpm install --frozen-lockfile
pnpm run db:migrate
# Gere UUIDs locais para subjectId/ownerId (ex.: node -e "console.log(require('node:crypto').randomUUID())")
pnpm run project:create -- <OWNER_UUID> "Projeto de teste" startup
# Copie projectId da saída:
pnpm run token:issue -- <PROJECT_UUID> <SUBJECT_UUID> integration tasks:read,tasks:create,tasks:transition,events:read 24
# A saída contém o token UMA vez. Guarde-o em local privado.
pnpm run build
pnpm start
# Revogação administrativa somente no terminal confiável:
pnpm run token:revoke -- <TOKEN_ID>
```

Para consultar, envie `Authorization: Bearer odt_...` ao endereço local, com HTTPS apenas após futura camada de publicação segura. Não incluir tokens em URLs. Use `/openapi.json` para inspecionar documentação sem expor qualquer dado de usuário.

O processo `project:create` / `token:issue` é confiável por **possuir credenciais de banco**, portanto não disponibilizar essa CLI a usuários não autorizados. Nesse estágio não há fluxo web de onboarding nem login de múltiplos usuários.

## 4. Contratos e evidências

`tests/auth-api.test.ts` cobre tokens hashed, revogação, expiração, 401, 403, 404 interprojeto, solicitação forjada, escopo read-only, JSON estrito, identidade `integration` e OpenAPI. `scripts/smoke-auth.mjs` inicia API compilada, cria tarefas usando token, bloqueia acesso sem credencial, reinicia API, comprova revogação e testa que bind externo é recusado.

Pipeline `pnpm run check` = lint, typecheck, testes, build, smoke legacy mock, worker compilado e Fastify compilado quando `DATABASE_URL` estiver definida. A CI possui PostgreSQL de teste efêmero; execução remota GitHub Actions ainda não confirmada, pois não há remote.

## 5. Segurança / trabalho futuro

- Tokens bearer são **segredos**. Mesmo sob hash no banco, qualquer vazamento de token em requisição/log permite uso até expiração/revogação. Não enviar por chat, screenshots ou arquivos Nox.
- Sem rate limiting/distributed auth, auditoria completa de usuário, MFA, gateway de identidade ou Cloudflare Access; antes do deploy remoto implementar S30–S32 e gates de segurança correspondentes.
- A role SQL de aplicação ainda tem privilégios de migração no ambiente local S04; em produção usar DB roles separadas e menor privilégio, proteger arquivos privados do runtime.
- Sem registro/auditoria completa de ações administrativas de tokens; isso ficará na evolução da gestão de identidades.
- S08 streaming SSE ainda não implementado; somente GET com cursor.
- S09–S11 ingresso multicliente/locks e integração Git ainda não implementados.
- S15 aprovação com diff e run reais ainda não implementada; endpoints humanos 403.
- Este commit não executa deploy Docker, Cloudflare Tunnel ou operação no servidor e não altera OmnyaFinance/OmnyaLog/S.P.I.D.E.R.

A API S07 é adequada à **validação local**, mas não equivale a uma API pública pronta para produção.

**Atualização S09:** Os dois caminhos de criação HTTP (`POST /v1/projects/:id/tasks` e `POST /v1/projects/:id/intake`) exigem agora `Idempotency-Key` UUID no header. Ambos invocam o mesmo `TaskIntakeService`; sem chave, 400. A CLI `token:issue` aceita dois argumentos opcionais adicionais `origin` (`chatgpt`, `desktop_commander`, `codex`, `vscode`, `web`, `cli`, `other`) e `channel` (`api`, `mcp`). Detalhes e contratos canônicos em [INTAKE.md](INTAKE.md).
