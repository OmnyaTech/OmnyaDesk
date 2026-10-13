# ADR-0009 — Scheduler transacional por projeto com leases e fencing (S10)

**Status:** aceito para agendamento local, não execução produtiva.

## Problema

A S09 aceita pedidos de clientes diferentes, mas não impede solicitações distintas de disputarem mesmo recurso. Precisamos reservar recursos por projeto antes de execução, permitir paralelismo independente, suportar dependências e resistir a falhas de processo.

## Decisão

- Classificar recursos de modo conservador: `repo` ou `path:<caminho relativo seguro>`; access mode `read`/`write`, incluindo conflitos entre pai/filho.
- Registrar plano imutável com dependências para tarefas existentes no mesmo projeto e prioridade 0–10.
- Usar transações PostgreSQL curtas serializadas por advisory lock por projeto para decisão/claim, sem manter transação durante trabalho externo. Contenção intra-projeto é proposital; claims de projetos distintos progridem independentemente.
- Persistir leases por tarefa/recurso; no vencimento recuperar tarefas para fila. Exigir proprietário, token UUID, fence monotônico e lease ainda válido em heartbeat e complete.
- HTTP local autenticado fornece registro, claim, heartbeat, complete, cancel e consulta.
- Cancelamento libera reservas e marca dependentes em fila como cancelados. Não força interrupção de processos externos.

## Limitações

O scheduler **não é sandbox**, e o worker S06 ainda não consulta essas reservas. Aplicar verificação mandatória de lease/fence ao executor/integração Git nas próximas sprints, ou o lock será apenas lógico. Caminhos case-folded são adequados ao Windows, mas symlinks/hardlinks e semântica dos arquivos não são verificados aqui; os worktrees e filesystem checks das S11–S13 são necessários. Priority starvation e milhares de tarefas requerem testes de escala posteriores. Sem garantias de linearizabilidade de I/O externo e sem alterarem estado FSM S05; `scheduled_tasks` representa a reserva, não o estado da tarefa no worker S06.
