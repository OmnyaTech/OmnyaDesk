# Backlog inicial priorizado

Sequência por dependência técnica, **não** promessa de datas.

## P0 — fundação

- `OD-001` Monorepo pnpm, lint, TypeScript rigoroso, CI e versionamento de contratos.
- `OD-002` PostgreSQL, migrations, aggregates, optimistic locking (`version`) e testes de transação.
- `OD-003` `TaskStateMachine`: eventos + outbox atômicos, estados e critérios de validação.
- `OD-004` pg-boss worker: filas, idempotência, cancelamento, retries e heartbeats.
- `OD-005` REST API Fastify + OpenAPI + autenticação local via token com escopos.
- `OD-006` Event streaming SSE com cursor e deduplicação.

**Gate P0:** tarefa e histórico sobrevivem a reboot; reprocessamento de job não duplica efeitos.

## P1 — primeira execução real

- `OD-007` `SandboxManager`: worktree isolado + isolamento do processo/container (worktree não é sandbox de SO).
- `OD-008` Política de ferramentas, allowlist de diretórios, limites de recursos e logs redigidos.
- `OD-009` `CodexProvider` streaming com custo/uso e cancelamento.
- `OD-010` Pipeline arquiteto → developer → QA → review (um provider, papéis distintos).
- `OD-011` Captura de diff, testes, hashes, resultados e decisões humanas.

**Gate P1:** execução real auditável em repositório descartável; nenhum push/merge automático.

## P2 — experiência visual

- `OD-012` Frontend React + Phaser responsivo, tiles/sprites iniciais licenciados.
- `OD-013` Mapeamento `event → animation`, inspeção de agente e atividade.
- `OD-014` VS Code extension com Webview, CSP, SecretStorage e anexos por canais seguros.
- `OD-015` CLI para tarefas, status, logs e aprovações.
- `OD-016` Teste e2e de interface com simulação controlada.

**Gate P2:** mesmo evento produz estados consistentes em web, CLI e VS Code.

## P3 — entrada MCP (local)

- `OD-017` Gateway MCP TypeScript v2 com tools read-only + `create_task`.
- `OD-018` Políticas por origin/escopo, auditoria e defesa contra prompt injection.
- `OD-019` Testes de interoperabilidade com clientes MCP locais.

**Gate P3:** nenhum cliente MCP consegue aprovar entrega ou executar comandos arbitrários.

## Pós-MVP (discovery)

- `OD-020` Integração Claude Agent SDK; `OD-021` Gemini headless; `OD-022` modelos locais.
- `OD-023` Reuniões com atas; `OD-024` mapa editável e templates; `OD-025` economia virtual.
- `OD-026` Conector remoto autenticado para ChatGPT e outros clientes.
