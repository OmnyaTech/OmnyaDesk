# S05 — Orquestração transacional e outbox (PostgreSQL)

**Status:** implementada para testes locais. A aplicação ainda NÃO possui autenticação, workers reais, notificações SSE persistentes ou acesso externo seguro.

## 1. Objetivo

Os dois itens da S05 são (a) máquina de estados de tarefas e (b) outbox atômica com idempotência. A implementação usa a migration `infra/migrations/002_task_fsm_outbox.sql` e os módulos `packages/db/src/orchestration.ts` e `packages/db/src/repository.ts`. A migration anterior `001_core.sql` **não foi alterada**.

### Persistência e integridade

- `task_runs` associa uma tentativa imutavelmente identificada a um único projeto/tarefa, com `attempt` único por tarefa. O worker e seu estado operacional real são responsabilidade da S06.
- `task_commands` guarda uma chave UUID por comando (no escopo de projeto/tarefa), fingerprint SHA-256 dos parâmetros e **snapshot** da resposta, permitindo retornar exatamente a resposta original mesmo depois de novas mudanças de estado.
- `task_outbox` guarda uma mensagem por evento, com ID único e payload imutável, ligada ao `task_events` por FK. `delivered_at` fica reservado ao futuro despachante S06; a S05 não entrega mensagens a serviços externos.
- O evento `task.created` de novas tarefas é criado junto com a linha de outbox, na **mesma transação**. A migration faz backfill de eventos `task.created` já existentes da S04, sem gerar duplicações.
- Transição: `SELECT ... FOR UPDATE` sobre a tarefa, verificação da versão esperada, validação da FSM de S03, geração da tentativa quando entra em `queued`, UPDATE versão+1, inserção do evento V1, outbox e registro idempotente; tudo submetido a **um COMMIT**, ou integralmente revertido.
- O lock PostgreSQL `pg_advisory_xact_lock(711133,5)` é usado perto da alocação das sequências de eventos/outbox para manter a ordem de commit entre **várias tarefas** e evitar saltos de cursor com transações simultâneas. É deliberadamente conservador: aumenta a contenção, a ser reavaliada com benchmark depois.
- Erros de versão, transição ilegal, reutilização da mesma chave para comando diferente ou identificador de projeto incorreto são negados. A repetição idêntica retorna `replayed: true` e não produz efeitos colaterais.

**Limite de idempotência:** o mecanismo acima cobre **comandos de transição**. A operação legada `POST /v1/projects/:id/tasks` de **criação** ainda não recebe chave idempotente e pode criar tarefas distintas em posts repetidos. A entrada de atividades multicliente e as chaves de criação serão tratadas na S09. Não interpretar o S05 como garantia de deduplicação de todo tipo de solicitação.

## 2. API local de teste

Com `DATABASE_URL` configurada para o banco da S04, a API compilada oferece:

| Verbo | Rota | Resultado |
|---|---|---|
| POST | `/v1/projects/:projectId/tasks/:taskId/transitions` | `{task,event,replayed}` |
| GET | `/v1/projects/:projectId/outbox?after=N` | Eventos persistidos por cursor `{messages:[{id,event}]}` |

Exemplo do payload de transição:

```json
{
  $111111111-1111-4111-8111-111111111111",
  "expectedVersion": 1,
  "to": "queued",
  "reason": null
}
```

O backend impõe `actor: system` e `source: api`, não aceita identidade humana enviada pelo cliente. As transições `approved` e `changes_requested` retornam **403** no endpoint local até S07 autenticar uma pessoa de verdade. Os testes internos do repositório avaliam o fluxo completo de aprovação/rejeição com um ator `human` simulado, mas isso **não constitui autenticação real**. Nenhuma decisão humana pode ser aprovada automaticamente por um agente.

O modo legado sem `DATABASE_URL` continua operando como mock em memória. O modo PostgreSQL continua restrito ao **loopback**; não publicar via Cloudflare Tunnel e não conectar outros usuários a ele até a S07.

## 3. Testes e operação

Usar PostgreSQL próprio, com base de testes separada e `DATABASE_URL` definida no ambiente local; a connection string é segredo e jamais deve entrar no Git ou nos logs.

```powershell
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run check
pnpm start
```

`pnpm run check` executa lint, typecheck, testes de contrato, unitários, testes reais com PostgreSQL, build e smoke da compilação. A CI configurada inclui serviço PostgreSQL efêmero; **GitHub Actions remoto ainda não executado**, na ausência de remote publicado.

Os testes validam: concorrência de 24 comandos com mesma chave, dois comandos divergentes na mesma versão, rollback forçado na outbox sem fragmentos, invariantes de aprovação, rework com novo run, cursor de replay, ordem de eventos em tarefas paralelas e persistência após reconexão. O smoke da API compilada verifica endpoints HTTP e sobrevivência após reiniciar API e PostgreSQL.

## 4. Próximas dependências

- S06 implementará jobs, workers, heartbeats, entrega com retry e marcação de `delivered_at`. **A outbox não é uma fila de trabalho operante ainda.**
- S07 implementará identidades, autenticação, escopos e autorização por objeto. Sem isso, apenas a interface local de teste não humana está liberada.
- S08 implementará SSE durável/cursor/reconexão sobre eventos.
- S09–S11 definirão a entrada e a coordenação entre ChatGPT/Codex, locks e fila de integração Git.
- S28+ implantará a stack independente no servidor com Cloudflare Tunnel e Access, após gates de segurança.

Mudanças nos esquemas após a S05 exigem migration `003_*.sql`; jamais modificar migrations aplicadas. Para qualquer cenário de produção, separar papéis SQL de migração e aplicação e realizar backup/restore testado.
