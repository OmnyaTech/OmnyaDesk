# OmnyaDesk — Contratos de domínio e eventos V1 (S03)

**Estado:** implementado e testado como contratos e invariantes puros. **Não** significa banco, fila, autenticação ou orquestração real habilitados.

## Fronteiras do domínio

O pacote `@omnyadesk/contracts` publica esquemas Zod estritos e os tipos TypeScript inferidos:

| Entidade | Propósito | Regras principais |
|---|---|---|
| `Project` | Repositório e titular responsável | ID, `ownerId` e `repositoryRoot` nullable |
| `Office` | Escritório virtual associado a projeto | template `startup`, `accounting` ou `custom` |
| `Department` | Setor organizacional do escritório | código estável; habilitação independente |
| `Skill` | Competência versionada do agente | ID, código e versão, sem vínculo obrigatório a provedor |
| `Agent` | Identidade funcional virtual | papel, setor, skills, política de provedor e habilitação |
| `Task` | Solicitação com estado e revisão otimista | projeto, escritório, solicitante, versão positiva e execução atual |
| `TaskRun` | Tentativa rastreável de realizar trabalho | agente, número de tentativa, orçamento inteiro e datas coerentes |
| `Approval` | Decisão humana vinculada a run e diff | hash SHA-256, quem decidiu, timestamps e estado |
| `Artifact` | Evidência de execução | projeto, run, caminho relativo, MIME, hash e tamanho |
| `ProviderPolicy` | Estratégia de seleção de modelo | automático ou fixo; provedor fixo precisa estar autorizado |

Todos os identificadores externos são UUID; instantes são ISO 8601 com fuso explícito. Esquemas usam `z.strictObject` e rejeitam campos extras. Valores de custo/limite são inteiros; não trafegar dinheiro em ponto flutuante.

**Limite atual:** schemas conferem formato e invariantes locais, não verificam FKs, permissões ou identidade autenticada. S04/S05/S07 implementam essas garantias no banco/serviços. `repositoryRoot`, `relativePath` e `actor.id` também exigirão validações de acesso e sandbox além deste contrato.

## Máquina de estados da tarefa

`TASK_LIFECYCLE_STATES`, `TASK_TRANSITIONS` e `canTransitionTask` são a referência **para o domínio alvo**, separada da FSM do protótipo.

```text
created -> queued -> planning -> implementing -> testing -> reviewing
                                                  -> awaiting_approval
                                                     | approved
                                                     | changes_requested -> queued (novo run)
                                                     | expired / cancelled

Estado de processamento -> retrying -> queued
                         -> blocked -> queued
                         -> failed / cancelled
```

Regras verificáveis:
- `approved`, `failed`, `cancelled`, `expired` são terminais.
- Aprovar direto de `created`, `planning` ou `reviewing` não é transição válida.
- Revisão rejeitada não pode ir direto para aprovação; retorno a `queued` exige **novo run** no evento.
- Um `TaskRun` `queued` não tem timestamps, `running` tem somente `startedAt`, e conclusões têm ambos.
- `Approval.pending` não pode conter decisão. `Approval.approved/rejected` exige identificador de quem decidiu e instante da decisão.

## Contrato de eventos V1

`VersionedDomainEventV1Schema` e `decodeDomainEventV1` validam o envelope e payload com `schemaVersion: 1`. O decoder é **fail-closed** para versões desconhecidas, tipos não declarados, campos inesperados e estados inválidos.

Campos comuns:
```text
schemaVersion (literal 1), eventId (UUID), sequence (positive integer),
occurredAt (ISO datetime com timezone),
projectId, officeId, taskId (UUID), runId (UUID | null),
actor ({kind: human|agent|integration|system, id}),
correlationId (UUID | null), causationId (UUID | null),
source (api|cli|mcp|vscode|web|worker|system),
type, payload.
```

Tipos V1 e validação de payload:
- `task.created` — título e identificador do solicitante.
- `task.status_changed` — `from`, `to`, `reason`, `newRunId`. Deve respeitar o grafo; para `to=approved`, o ator é humano e `runId` é obrigatório; reenvio de `changes_requested` precisa citar o novo run.
- `task_run.started` — agente e tentativa, exige run.
- `task_run.finished` — resultado e motivo opcional, exige run.
- `approval.requested` — ID da aprovação e hash SHA-256 do diff, exige run.
- `approval.decided` — decisão, diff SHA-256, ID da aprovação e humano identificado como autor; exige run.
- `artifact.recorded` — ID do artefato, caminho e hash, exige run.

O registro do evento será imutável **na persistência futura** (append-only); este schema só valida o contrato de mensagem. Unicidade de `eventId` e `sequence`, consistência de FKs, ordem causal, autorização do humano, comparação do diff aprovado com o real e idempotência serão implementadas em S04–S15 e testadas em suas próprias sprints.

## Compatibilidade com o protótipo S01–S02

O tipo `OfficeEvent` antigo possui `id: number`, `at`, `actor: AgentRole`, `status` e `message`. A rota atual `GET /api/events` continua entregando **somente** esse formato, sem `schemaVersion`; nenhum frontend foi migrado por esta sprint.

**Não reinterpretar um evento legado como V1.** Um conversor explícito e com critérios de dados será necessário quando a S04/S05/S08 introduzir persistência/outbox/SSE. Versionamento futuro (`schemaVersion: 2`) exige schema novo e adaptador de compatibilidade testado. Nunca aplicar `parseV1` a dados legados ou renomear campos sem migração.

## Provedores, outros escritórios e segurança

O papel e identidade de um agente não se confundem com a IA que o executa. `ProviderPolicy` restringe quais fornecedores podem ser selecionados; validação de credenciais, orçamento e capacidade real fica no runtime futuro.

A presença do template `accounting` significa apenas suporte contratual do tipo de escritório. **Não** implementa obrigações fiscais, folha, contabilidade ou processamento de dados sensíveis. Não expor a API atual via Cloudflare Tunnel; permanece mock sem autenticação.

## Critério de regressão

`pnpm run check` precisa aprovar schemas, transições, eventos, build e smoke do protótipo. Executar `pnpm install --frozen-lockfile` numa cópia limpa do Git antes de marcar S03 concluída.
