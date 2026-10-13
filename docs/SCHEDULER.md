# S10 — Agendador de concorrência por recursos

**Escopo (2 itens):** classificação de recursos, acessos, prioridades e dependências; agendamento persistente com leases/locks, fila, TTL, recuperação e fencing. **Apenas localhost e PostgreSQL de teste.**

## 1. Contrato e escopo

A S09 recebe solicitações de clientes com identidade e idempotência. A S10 fornece uma **operação de preparação de execução**: cadastrar quais recursos uma tarefa irá ler/escrever, opcionalmente de quais tarefas ela depende, e qual é sua prioridade (0 a 10). O plano é imutável depois de registrado, para que o executor não possa silenciosamente diminuir os recursos declarados.

- `repo` — o repositório inteiro; padrão conservador recomendado para qualquer alteração de código ainda sem isolamento.
- `path:src/api`, `path:docs/readme.md` — caminhos relativos ao repositório. São convertidos para minúsculas, independentemente do cliente Windows (sem `..`, backslash, caminhos absolutos, segmentos vazios ou `.`). Isto reduz colisões de nomes em Windows e impede escapar pela especificação do recurso.
- `read` — vários leitores podem coexistir; uma escrita sobre o mesmo recurso ou um caminho pai/filho bloqueia leitores.
- `write` — acesso exclusivo para recurso coincidente, ancestral ou descendente. `repo` conflita com qualquer caminho se ao menos um dos acessos é `write`.
- Máximo de 16 recursos e 32 dependências por tarefa; registros repetidos, mistura de `repo` com caminho e dependências auto-referenciais são rejeitados.
- `dependsOn` referencia tarefas já registradas no mesmo projeto. A dependência só libera a tarefa quando a predecessora terminou em `completed` no agendador. Esse contrato incremental, sem edição de arestas, previne ciclos por construção.
- A prioridade ordena **tarefas elegíveis**, maiores valores primeiro, seguida de criação e ID como desempate. Uma tarefa bloqueada por dependência/recurso não impede que outra independente comece.

### Rotas Fastify local (Bearer token com `tasks:transition`)

```text
POST /v1/projects/:projectId/tasks/:taskId/schedule
  body: {"priority":8,"resources":[{"key":"path:src/api","mode":"write"}],"dependsOn":[]}
  => 201

POST /v1/projects/:projectId/scheduler/claim
  body: {"ttlMs":30000}
  => 200 {"claim":{...}} ou {"claim":null}

POST /v1/projects/:projectId/tasks/:taskId/schedule/heartbeat
  body: {"leaseToken":"UUID","fence":1,"ttlMs":30000}
  => 200 leaseUntil ou 409 para lease inválido/expirado

POST /v1/projects/:projectId/tasks/:taskId/schedule/complete
  body: {"leaseToken":"UUID","fence":1}
  => 200 ou 409 para lease inválido/expirado

POST /v1/projects/:projectId/tasks/:taskId/schedule/cancel
  => 200 {"cancelled":true|false}

GET /v1/projects/:projectId/tasks/:taskId/schedule
  => leitura permitida com tasks:read; não inclui leaseToken
```

Nenhuma rota aceita `workerId` do cliente: a API usa `subjectId` autenticado do token como proprietário do lease. Cross-project retorna 404, falta de autenticação 401, escopo insuficiente 403. Campos extra e valores inválidos são rejeitados por JSON Schema/Zod.

## 2. Algoritmo, integridade e recuperação

As quatro tabelas da migration `006_resource_scheduler.sql` são `scheduled_tasks`, `scheduled_resources`, `scheduled_dependencies` e `resource_leases`. Todos os IDs são scoped por projeto e possuem FKs compostas. A fila e os locks são persistidos no PostgreSQL; não há mutex em memória como fonte da verdade.

A cada operação de agendamento ou heartbeat, o servidor mantém uma transação curta com **advisory lock por projeto**, garantindo ordem única de decisão, sem segurar o lock enquanto o worker executa. O banco procura tarefas elegíveis, verifica as reservas não expiradas e seleciona a primeira compatível. Pedidos por projeto diferente não compartilham esse lock. A busca cobre até 1.000 entradas elegíveis por claim, limite local documentado para revisão em escala.

O proprietário recebe `leaseToken` UUID aleatório + `fence` inteiro que aumenta em cada retomada + `leaseUntil`. O valor TTL fica entre 250 ms e 120 s. Heartbeat renova o lease se e somente se token, fence, proprietário, projeto e prazo ainda coincidirem. `complete` possui a mesma checagem. Um worker antigo, após crash, expiração ou cancelamento, não consegue confirmar sua tarefa.

Claims subsequentes fazem *reaper* de reservas expiradas (removendo seus resource_leases), recolocam a tarefa em fila e aumentam o fence na nova concessão. Nenhum worker deve executar tarefas após perder o lease. Cancelamento libera recursos imediatamente; dependentes ainda na fila de uma predecessora cancelada são cancelados transitivamente.

### Limites técnicos e integração seguinte

**S10 protege reservas emitidas pelo próprio agendador; ela ainda não intercepta modificações diretas no Git ou filesystem.** Uma execução externa que não obtenha lease não está automaticamente contida, e a implementação S06 de `worker_jobs` ainda roda separadamente. **Não interpretar o resultado como isolamento efetivo do PC/repositório ou agendamento de modelos reais.** As S11–S13 deverão integrar worktrees, validação de alterações, sandbox e gateway de ferramentas com verificação obrigatória do lease/fence.

O fence impede conclusões **dentro do serviço do scheduler**, não impede por si só que um processo externo escreva arquivos se ignorar o protocolo. Sem produção, controle de semântica de negócio ou diff review. A infraestrutura Docker/Cloudflare e agentes reais permanecem planejados.

## 3. Quality gates

`tests/scheduler.test.ts` valida classificação/normalização, read/write, hierarquia de paths, prioridade, dependências, isolação de tenant, 25 workers/20 recursos, 30 disputas de lock exclusivo, timeout/heartbeat/fence, retomada em novo pool, cancelamento transitivo, 30 planos com múltiplos recursos sem deadlock e endpoints HTTP com autorização.

`scripts/smoke-scheduler.mjs` usa **API compilada**, um processo claimant externo `scheduler-probe.mjs` que termina após receber lease, processo de API reiniciado, recuperação após TTL, novo fencing, acesso concorrente independente e recusa de conclusão antiga. Este smoke faz parte de `pnpm run check` em PostgreSQL configurado e gera evidências canônicas no Nox.

**Segurança:** tokens são segredos. Nunca repassar segredos de API ou URLs de banco por chat ou commits. Este serviço não deve ser publicado fora de loopback; não houve deploy em servidor existente.

**Interface pixel:** a segunda referência visual escolhida para OmnyaDesk permanece no roadmap de aplicação desktop, sem alteração nesta sprint.

### Revisão de precisão temporal (QA S10)

O PostgreSQL mantém timestamps com precisão de microssegundos; a conversão intermediária para `Date` do JavaScript perdia até 0,999 ms quando os prazos dos recursos eram copiados para `resource_leases`. A implementação passou a copiar `lease_until` **diretamente via SQL** em `claim` e `heartbeat`. O teste de regressão comprova `resource_leases.expires_at = scheduled_tasks.lease_until` exato para novos leases. Os registros sintéticos gerados **antes** da correção podem preservar a diferença histórica inferior a 1 ms na base local; nenhuma mudança destrutiva foi feita neles. O gate QA verifica fences exatos e tolerância de no máximo 2 ms apenas para esses registros legados.
