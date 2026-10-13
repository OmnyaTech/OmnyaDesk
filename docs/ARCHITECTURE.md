# Arquitetura técnica inicial — OmnyaDesk Hybrid

Status: **DECISÃO PROPOSTA / v0.1 (2026-10-10)**. Código entregue no pacote é um **mock local**, não esta arquitetura completa.

## Propósito

Sistema operacional de escritórios multiagentes: solicitações criam tarefas, agentes especializados produzem artefatos, revisores verificam evidências, humanos aprovam alterações e um mundo pixelado reflete eventos persistidos.

**Invariante:** o mundo visual **não pode produzir estados de execução**. Ele apenas interpreta eventos do domínio emitidos pelo backend.

## Módulos de produção

```text
VS Code Webview <--- extensão ---+              +--> PostgreSQL (read models + events)
Web React/Phaser ---------------+-> Fastify API +--> pg-boss (filas/retries)
CLI -----------------------------+       |        +--> Artifact store (files+hashes)
                                       |
                                Orchestrator (FSM)
                                       |
              +------------------------+------------------------+
              |                        |                        |
       Agent Provider Adapter    Tool Gateway          Policy/Approval Gate
        (Codex primeiro)       (Git, files, tests)      (human, budgets)
              |                        |                        |
       sandbox runner              sandbox runner        audit/outbox

Gateway MCP v2 autenticado -> traduz tools para comandos da API; não executa bypass do domínio.
```

### Interfaces

- **Web App**: React, Phaser, cliente SSE; o Phaser exibe sprites/ambientação, React exibe tarefas, logs, diffs e formulários.
- **VS Code Extension**: Webview com CSP restrita, comunicação `postMessage` tipada com extension host. A extensão detém URI do projeto e seleção de arquivos. Credenciais ficam no SecretStorage, não no Webview.
- **CLI**: usa a mesma API. Não duplica regras de domínio.
- **MCP Gateway**: ferramentas de consulta e solicitação via API; autenticação, escopos, idempotência e auditoria. `stdio` para clientes locais e Streamable HTTP autenticado para clientes remotos (não expor processo do PC diretamente).

### Core e trabalhadores

- **Domain**: `Project`, `Office`, `Department`, `Agent`, `Skill`, `Task`, `TaskRun`, `Approval`, `Artifact`, `OfficeEvent`, `ProviderPolicy`.
- **Orchestrator**: máquina de estados explícita; executa DAG simples de passos; sem loops sem limite; política e orçamento antes de enviar tarefas aos workers.
- **Worker**: consome jobs persistidos de pg-boss, cria ambiente de execução, emite heartbeats e artefatos, registra uso e resultados. Retries com idempotência e limites.
- **Tool Gateway**: executa Git, testes e operações de arquivo somente em sandbox e worktree autorizados, com registro de comandos, paths e diffs.
- **Agent Adapters**: contrato único; `MockProvider` para testes, `CodexProvider` como primeiro runtime real; Claude, Gemini e local apenas depois.

### Modelo inicial de dados

| Agregado/tabela | Campos principais | Observação |
|---|---|---|
| projects | id, name, repo_root, created_at | `repo_root` apenas local e validado |
| agents | id, project_id, role, provider_policy, enabled | Papel != modelo |
| tasks | id, project_id, title, description, status, version | Fonte do estado atual |
| task_runs | id, task_id, agent_id, status, attempt, started_at, ended_at | Execução observável |
| task_events | id sequencial, task_id, type, actor, payload, at | Log append-only |
| approvals | id, task_id, requested_by, decided_by, status, at | Sem autoaprovação por agentes |
| artifacts | id, task_id, mime, path, sha256, size | Evidências assinadas/hash |
| outbox | id, event_type, payload, delivered_at | Entrega confiável após commit |

**Transações:** ao alterar uma tarefa, inserir evento e entrada outbox na mesma transação SQL. Publicadores assíncronos distribuem para SSE e fila; entregas são `at-least-once`, consumidores precisam deduplicar por ID/versão. Não afirmar exactly-once.

### Estados do domínio (alvo)

`created → queued → planning → implementing → testing → reviewing → awaiting_approval → approved`.

Exceções explícitas: `blocked`, `retrying`, `failed`, `cancelled`, `changes_requested` e `expired`. Reenvio de ajustes produz **nova execução** vinculada à anterior; não alterar histórico nem sobrescrever eventos. Um run pode terminar sem aprovar a tarefa.

**No mock** existe um fluxo menor, sem filas, retries, persistência ou artefatos; a rejeição é terminal. Isto é intencional.

### Reuniões

- Post-MVP: `Meeting` precisa conter objetivo, participantes, documentos citados, limite de rodadas e ata com decisão e responsáveis.
- Nunca permitir reuniões recursivas sem limite de custo e duração. Primeiro MVP não precisa de reunião automática.

### Contrato de eventos

Envelope de produção proposto:

```json
{
  "eventId": "uuid",
  "sequence": 173,
  "occurredAt": "2026-10-10T17:00:00.000Z",
  "officeId": "uuid",
  "projectId": "uuid",
  "taskId": "uuid",
  "runId": "uuid",
  "type": "task.status_changed",
  "actor": { "kind": "agent", "id": "uuid" },
  "payload": { "from": "implementing", "to": "testing" },
  "schemaVersion": 1
}
```

O evento `agent.moved_to_desk` deve ser **derivado** pelo visualizador de `task.status_changed`. Não cria a verdade do domínio.

### Contrato base dos provedores

A S16 define o contrato normativo em `packages/contracts/src/provider.ts`, reexportado por `index.ts`: `AgentProvider`, `AgentExecutionRequest`, `AgentExecutionResult` e eventos tipados de streaming. O request contém `projectId`, `taskId`, `runId`, papel, `modelId`, `allowedTools` (metadados, nunca permissão), budget e `sandboxId`. `MockProvider` fornece streaming/cancelamento determinístico, sem rede ou execução de comandos; detalhes em [PROVIDER_MOCK.md](PROVIDER_MOCK.md). S17 implementará o primeiro adapter real, sempre no sandbox autorizado. Não compartilhar segredos em prompts ou logs.

### Endpoints previstos de produção

- `GET /v1/projects`, `POST /v1/projects`
- `GET /v1/projects/:id/tasks`, `POST /v1/projects/:id/tasks`
- `POST /v1/tasks/:id/execute`, `POST /v1/tasks/:id/cancel`
- `GET /v1/tasks/:id`, `GET /v1/tasks/:id/events`
- `GET /v1/tasks/:id/artifacts`, `GET /v1/tasks/:id/diff`
- `POST /v1/approvals/:id/decision`
- `GET /v1/offices/:id/events` (SSE com replay/cursor)

`POST` sensíveis devem exigir `Idempotency-Key` e autorização adequada.

### MCP tools previstas

- `office.list_projects`, `office.get_status`, `office.create_task`
- `office.get_task`, `office.list_tasks`, `office.get_task_artifacts`
- `office.request_meeting` (após MVP)

Aprovação humana via UI autenticada e com identidade vinculada; não delegar indiscriminadamente `approval.grant` para qualquer agente/cliente MCP.

### Por que SSE inicialmente?

O fluxo inicial dominante é unidirecional backend → cliente (eventos). Os comandos seguem REST. SSE fornece reconexão nativa com `Last-Event-ID` e menor esforço que WebSocket para este caso. Se futuramente houver presença/colaboração interativa de alta frequência, incorporar WebSocket sem afetar o domínio.

### Primeira integração LLM (alvo)

Priorizar Codex SDK de TypeScript (`@openai/codex-sdk`) em sandbox com aprovação de operações sensíveis. A autenticação, permissões, ambiente e custo serão validados antes de ativar. Outros provedores entram **somente por adapters**.

Documentação verificada:
- https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/
- https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- https://code.visualstudio.com/api/extension-guides/webview
- https://pgboss.io/introduction


### Implementação de contratos (S03)

O domínio alvo acima agora tem contratos e invariantes implementados em `packages/contracts/src/domain.ts` e envelopes V1 em `packages/contracts/src/events.ts`, com validação Zod e testes. **O exemplo anterior de envelope é ilustrativo**; o contrato normativo V1 usa `payload` discriminado por tipo e campos definidos em [CONTRACTS.md](CONTRACTS.md). A API mock e SSE continuam no formato legado até a etapa de migração, conforme [ADR-0004](adr/0004-domain-events-v1.md).
