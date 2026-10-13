# S09 — Ingresso único multicliente com proveniência e idempotência

**Escopo da sprint (dois itens):** (1) entrada canônica compartilhada entre API Fastify e protocolo MCP local, para clientes ChatGPT, Desktop Commander, Codex e VS Code; (2) registro durável de ator, origem, projeto, autorização e chave de idempotência. A experiência visual segue como referência a **segunda prévia pixel art aprovada pelo usuário**, mas nenhuma interface pixel ou extensão é implementada nesta sprint.

## Arquitetura de ingresso

```text
ChatGPT / Desktop Commander / Codex / VS Code (futuras conexões)
  |  Token individual emitido pelo administrador: origem, canal, projeto, escopos
  |-- HTTP POST /v1/projects/:projectId/intake --  |-- POST /v1/projects/:projectId/tasks ------+--> TaskIntakeService
  `-- MCP stdio: submit_task --> HTTP local ---/
            |
            + PostgreSQL TRANSACTION
               tasks + task_events(task.created) + task_outbox +
               task_intake_requests (receipt, tokenId, origem, ator, chave)
```

A API e a ferramenta MCP usam a **mesma implementação de serviço transacional**. O endpoint antigo `POST /v1/projects/:id/tasks` tornou-se *alias da entrada canônica* e **também exige** `Idempotency-Key`; não há via autenticada de criação HTTP sem esse controle. O `PostgresOfficeRepository.createTask` interno permanece em uso por testes e bootstrap de S04, **não é exposto diretamente** na API persistente.

## 1. Contrato HTTP

`POST /v1/projects/:projectId/intake`

Headers obrigatórios:
- `Authorization: Bearer odt_...` — token de escopo `tasks:create` e projeto correspondente.
- `Idempotency-Key: <UUID aleatório não nulo>` — gere uma vez por solicitação lógica; reutilize **a mesma chave e payload** em retries.

Exemplo de JSON:

```json
{"officeId":"b4f0ce17-57a8-4eb5-92c6-3ae4dd1891a0","title":"Implementar conciliação","description":"Implementação autorizada e documentada"}
```

A resposta inicial é HTTP **201** com `{task,eventId,idempotencyKey,origin,channel,actor,acceptedAt,replayed:false}`. Retry idêntico (mesmo projeto, solicitante e chave) é HTTP **200** e reproduz o recibo original, com `replayed:true`. Se o conteúdo/cliente registrado diferir mantendo a chave, retorna **409** sem escrever tarefa/evento. Sem chave ou chave inválida: **400**. Sem token ou revogado: **401**. Sem `tasks:create`: **403**. Projeto de outro cliente: **404**. Office FK inválida: **409** com rollback integral.

`GET /v1/projects/:projectId/tasks/:taskId/intake` usa `tasks:read` e retorna a proveniência para a futura UI: `origin`, `channel`, `actor`, `eventId`, `idempotencyKey`, `acceptedAt`. Em tarefas antigas, anteriores à S09, responde 404: **não inventa proveniência histórica**.

O cliente **não escolhe** ator/origem/projeto/canal por campos no corpo. JSON Schema é estrito e rejeita propriedades não previstas. Identidade, escopo, canal e origem são determinados pelo token provisionado pela CLI local; a camada de persistência também verifica revogação, validade e escopo no mesmo transaction lock antes de gravar.

## 2. Proveniência e identidade

A migração `005_canonical_intake.sql` adiciona campos a `api_tokens`: `client_origin` e `intake_channel`, com defaults `cli/api` para tokens já emitidos. Os valores de origem autorizados são `chatgpt`, `desktop_commander`, `codex`, `vscode`, `web`, `cli`, `other`. O canal é `api` ou `mcp`. O token tem `subject_id` e `subject_kind` próprios; não confundir o **operador humano** com o **cliente técnico** que encaminha sua solicitação.

A tabela `task_intake_requests` tem PK composta `(project_id,subject_id,idempotency_key)`; registra `task_id`, `office_id`, `token_id`, `client_origin`, `intake_channel`, fingerprint SHA-256 e recibo imutável por contrato. FKs rejeitam associação com tarefas/offices de outro projeto. `task.created` é emitido com `actor` autenticado, `source=api|mcp` e `correlationId=idempotencyKey`, sem alteração do contrato de eventos V1. A outbox é registrada na mesma transação.

**Limite de identidade:** a origem é registrada **no provisionamento do token**, não comprovada por atestado criptográfico de que o executável chamador é realmente a marca indicada. O portador de um token roubado poderia utilizar o perfil daquele token, daí a necessidade de tratar tokens como segredos, restringir permissões e revogar em caso de suspeita. A conexão real/conta de terceiros será validada nas sprints próprias.

## 3. Idempotência e concorrência

`TaskIntakeService` adquire lock transacional por projeto+solicitante+chave, valida um fingerprint canônico dos campos e da identidade registrada, compara recibos já persistidos e executa inserções na mesma transação. Usa lock global já adotado em S05 para preservar a ordem de commit de eventos/outbox S08. Na corrida de **30 chamadas simultâneas com a mesma chave**, ocorre uma criação e 29 replays sem novos eventos.

Retry depois de reiniciar a API retorna o **mesmo taskId e eventId**. Chaves iguais podem ser reutilizadas por pessoas diferentes em um projeto, pois os solicitantes têm escopos independentes. Só a confirmação de inclusão no banco é idempotente — **não** significa que a execução posterior por agentes reais já esteja coordenada. Conflitos entre worktrees e jobs independentes permanecem planejados para S10–S11.

## 4. MCP stdio local

`apps/mcp/src/main.ts` é um servidor MCP com SDK oficial, ferramenta `submit_task(projectId,officeId,title,description,idempotencyKey)`. Não acessa o PostgreSQL; encaminha por `fetch` ao endpoint HTTP autenticado do Fastify. `OMNYA_MCP_URL` **só aceita host loopback**, em HTTP, sem usuário, senha, query ou fragmento. O token nunca é exibido pela ferramenta ou incluído na URL.

Para usar num cliente MCP local autorizado, inicie primeiro a API Fastify autenticada e registre um token específico do projeto/canal MCP por uma CLI administrativa:
```powershell
pnpm run token:issue -- <PROJECT_UUID> <SUBJECT_UUID> integration tasks:create,tasks:read,events:read 24 desktop_commander mcp
pnpm run build
# No processo local do cliente MCP, defina OMNYA_MCP_TOKEN no ambiente seguro
# opcionalmente OMNYA_MCP_URL=http://127.0.0.1:4317/
pnpm run mcp:stdio
```

O MCP usa exclusivamente **stdout para o protocolo**. Não configure `DATABASE_URL` no processo MCP nem compartilhe token/secret no chat. A ferramenta responde com o recibo JSON ou uma mensagem sanitizada de erro. `scripts/smoke-mcp.mjs` inicia cliente e servidor SDK por stdio em processos reais, cria e retransmite tarefa, reinicia API, rejeita chave reutilizada com payload alterado e impede acesso após revogação do token. **Não há instalação automática dos conectores do ChatGPT/Codex/VS Code na S09**; MCP Gateway e integrações finais pertencem às S24/S34–S36.

## 5. Evidência e restrições

`tests/intake.test.ts` valida registros das quatro origens, 30 requests concorrentes, mudanças de payload, diferentes solicitantes, rollback FK, identidade não falsificável por corpo, scope 401/403/404, revogação e replay depois de reconexão, OpenAPI e MCP-profile. `scripts/smoke-mcp.mjs` valida o protocolo stdio **real**. `pnpm run check` passa por testes, lint, typecheck, build e cinco smokes compilados quando `DATABASE_URL` é o PostgreSQL local isolado. Evidências no Nox.

**Não publicado:** nenhum container do servidor, porta externa ou Cloudflare foi alterado. S10 implementará locks/conflitos de recursos; S11 integração Git; S15 aprovação humana segura; sprints posteriores conectarão efetivamente as ferramentas e UI pixel. Não usar o token MCP em navegador/URL/logs.
