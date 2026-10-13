# S06 — Worker durável, heartbeats, cancelamento e retry

**Escopo entregue:** (1) fila durável de execuções e recuperação por leases; (2) cancelamento e retry com limite. **Não executa nenhum modelo de IA**: o handler da S06 é intencionalmente simulado, sem comandos em terminal e sem efeitos externos.

## Arquitetura

- `infra/migrations/003_worker_queue.sql`: `worker_jobs` (FK composta de run e tarefa, `UNIQUE(run_id)`, estados, tentativas, expiração e cancelamento) e `worker_effects` (um resultado por run). Backfill apenas de runs anteriores ainda em `queued`. Migrations S04/S05 não alteradas.
- `packages/db/src/orchestration.ts`: uma mudança da tarefa para `queued` enfileira sua execução **na mesma transação** do estado, comando idempotente, evento V1 e outbox. A transição da tarefa para `cancelled` cancela o job pendente ou solicita cancelamento do job em execução.
- `packages/db/src/worker-queue.ts`: claim via `FOR UPDATE SKIP LOCKED`; lease com token UUID, worker owner e deadline; heartbeat renova somente token vigente; reaper recupera jobs de leases expirados e respeita `max_attempts`. Persistência e fencing no PostgreSQL.
- `packages/db/src/worker-runtime.ts`: handler com `AbortSignal`, heartbeats periódicos e gravação de resultado. Resultado só é confirmado enquanto a posse do lease permanece válida.
- `apps/worker/src/main.ts`: worker compilado em processo independente, modo `--once` ou polling; respeita `WORKER_PROJECT_ID` opcional para limitar o escopo.
- `scripts/copy-web.mjs`: a compilação copia HTML e migrations para `dist`, necessárias ao startup standalone do worker.
- `scripts/smoke-worker.mjs`: CI exercita worker compilado com PostgreSQL de teste quando `DATABASE_URL` está presente.

### Estados do job (não da tarefa)

`queued → running → succeeded`, com `running → queued` (retry/lease vencido), `running → failed` (limite esgotado) e `queued/running → cancelled`. A tabela `task_runs` de S05 já registra o ID lógico da execução; `attempt_count` em `worker_jobs` representa tentativas **técnicas** sobre o mesmo run. A FSM de tarefas S03–S05 continua separada; a S06 não avança automaticamente `planning/implementing/testing`, porque não existem agentes reais ainda.

### Concorrência e recuperação

Um claim usa lock na linha do job com `SKIP LOCKED`. Heartbeat válido estende `leased_until`. Após queda do worker sem heartbeat, `reapExpired` devolve à fila (ou marca como falho/cancelado), e outra instância pode obter **novo token**. Qualquer tentativa de concluir com token antigo é negada.

A confirmação atual grava em uma transação o marcador em `worker_effects` com `run_id` único e altera job para `succeeded`; isso impede duplicação de **efeitos de banco**. NÃO constitui exactly-once para operações externas: chamadas a LLMs, shell, Git e APIs futuras exigirão deduplicação específica, checkpoint e fencing do destino. Não executar operações externas não idempotentes no handler de demonstração.

Cancelamento é cooperativo: numa execução ativa, o cancel flag impede heartbeat/commit e o runner sinaliza `AbortSignal`. Se o processo estiver travado, o lease expira e o reaper o encerra logicamente. O cancelamento não desfaz efeito externo já consumado.

O retry usa backoff limitado (100 ms base, dobra a cada falha e é limitado a 60 s por tentativa) e no máximo `max_attempts` tentativas, padrão 3. Na aplicação real será configurado por classe de trabalho, não por payload arbitrário do usuário.

## Como executar localmente

Usar somente PostgreSQL isolado do projeto, sem dados pessoais e com `DATABASE_URL` fornecida por variável de ambiente (não em arquivo versionado).

```powershell
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run check
pnpm run worker:once
# ou, para polling contínuo até SIGINT/SIGTERM:
pnpm run worker
```

`WORKER_PROJECT_ID` (UUID) limita o consumo a um projeto de testes; `WORKER_LEASE_MS` e `WORKER_SIMULATED_MS` ajustam lease e demora sintética (dentro dos limites validados). O worker CLI, quando não recebe filtro, pode consumir qualquer job pendente desse banco — só usar num ambiente isolado. **Não iniciar o worker de demonstração no servidor de produção.**

### Testes e evidências

`tests/worker.test.ts` cobre concorrência de leases, claims isolados por projeto, heartbeat, cancelamento via fila e FSM, retry exaustivo, recuperação de crash, fencing e efeito único por run após reconexão. `pnpm run check` inclui um smoke do worker compilado no PostgreSQL (quando há DATABASE_URL).

`.nox/evidence/S06/crash-recovery-smoke.json` comprova um worker Windows real encerrado à força (`taskkill /F`), lease expirado, retomada por um segundo processo e sobrevivência de dados após reinício do banco. Logs/evidências não registram connection string.

## Decisão arquitetural

A abordagem preliminar do mapa mencionava `pg-boss`. Nesta sprint foi adotada uma fila PostgreSQL minimalista e delimitada, diretamente vinculada ao `task_runs`, com fencing verificável por token e persistência no próprio banco. **Trade-off:** manutenção do algoritmo de leasing/retries fica sob nossa responsabilidade. Antes de operar alto volume ou jobs com efeitos externos, revisar a adoção de `pg-boss`/fila madura, desempenho, observabilidade e testes de falha distribuída. Não apresentar esta prova de conceito como engine de produção.

## Restrições e próximas sprints

- S07: autenticação/autorização por projeto; no momento, API local não está autenticada e é proibido publicar em Cloudflare Tunnel.
- S08: streaming SSE durável da outbox.
- S09–S11: ingresso de múltiplos clientes, coordenação entre Codex/ChatGPT/Claude e locks Git.
- S12+: providers e tools reais com sandbox, aprovação, limites e auditoria.
- S28+: stack Docker no servidor, Cloudflare Access e operação remota.

O workflow GitHub Actions está configurado, mas **não há execução remota comprovada** até conectar e publicar um remote autorizado. Esta sprint não altera os containers OmnyaLog, OmnyaFinance ou S.P.I.D.E.R.
