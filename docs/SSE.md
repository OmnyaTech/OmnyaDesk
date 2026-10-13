# S08 — Eventos SSE com cursor persistente, reidratação e deduplicação

**Escopo (2 itens):** (1) SSE autenticado com cursor; (2) reidratação após queda e descarte de eventos duplicados pelo cliente. **Somente ambiente local**. Não é uma integração Cloudflare ou dashboard mobile.

## API

`GET /v1/projects/:projectId/stream` abre `text/event-stream` com `Authorization: Bearer <TOKEN>` e requer o escopo `events:read` do mesmo projeto. O endpoint documentado em `/openapi.json` reutiliza os contratos Fastify da S07.

Cada mensagem usa o **ID da linha `task_outbox.id`** como cursor (um inteiro positivo e crescente) e o envelope persistido `VersionedDomainEventV1`. Uma mensagem exemplo, com IDs sintéticos:

```text
id: 125
event: office
data: {"id":125,"event":{"schemaVersion":1,"eventId":"...","sequence":123,"occurredAt":"...","projectId":"...","officeId":"...","taskId":"...","runId":null,"actor":{"kind":"system","id":"system"},"correlationId":null,"causationId":null,"source":"api","type":"task.created","payload":{"title":"teste","requestedBy":"..."}}}
```

O cursor no SSE é **outbox.id**, não `event.sequence`. O cursor do endpoint `GET .../events` é `event.sequence` e não deve ser utilizado para retomar SSE. O endpoint `GET /v1/projects/:id/outbox?after=N` usa o mesmo cursor numérico do SSE.

## Reidratação e cliente

- Sem cursor, o servidor faz replay desde 0 (toda a história persistida do projeto).
- Para retomar, envie `Last-Event-ID: <último id confirmado pelo cliente>` ou a query `?after=<id>`. O header tem precedência quando ambos estão presentes. Cursor inválido retorna HTTP 400.
- O replay percorre a outbox em lotes de 500 ordenados por ID, até alcançar o último registro, **sem intervalo entre a reidratação e os novos eventos ao vivo**. Depois consulta o banco a cada ~150 ms. Um ID global pode conter lacunas entre os registros de um projeto, porque outros projetos também usam a mesma outbox.
- O consumidor deve salvar o cursor **por projeto**, preferencialmente após processar o evento. `packages/core/src/replay-cursor.ts` expõe `ReplayCursor`, que valida envelopes V1, rejeita eventos de outro projeto e ignora IDs já vistos/mais antigos. O estado persistente do cursor fica sob responsabilidade do cliente futuro (S18+), não de um serviço inexistente.
- A semântica é **at-least-once**, não exactly-once. Se a conexão cair após o servidor escrever a mensagem e antes do cliente confirmar a leitura, o próximo replay pode repetir essa mensagem. A UI deve processar eventos de maneira idempotente.
- Um cliente deve usar **fetch com streaming e header Authorization**. O `EventSource` nativo do browser não permite definir esse header, portanto não colocar token em query string ou URL para contornar a restrição.
- Heartbeats `: heartbeat` aproximadamente a cada 10 s não alteram o cursor.

### Exemplo mínimo de cliente

O app web/mobile futuro deverá usar um leitor SSE com `fetch`, extrair `id`, `event` e `data` e chamar `ReplayCursor.ingest(message)`. Depois de aplicar com sucesso o evento, persistir `cursor.lastEventId()` localmente. Para reconectar, usar esse valor no header `Last-Event-ID`. O parser testado para o protótipo está em `tests/sse.test.ts`; a S08 não inventa interface gráfica nova.

## Segurança e operação

- A verificação de autenticação S07 é reaplicada periodicamente (aproximadamente a cada 1 s) durante a conexão. Um token revogado/expirado encerra o stream atual; nova conexão retorna 401. Sem `events:read`: 403; projeto diferente: 404.
- Limite de 16 streams simultâneos por instância local do Fastify; o 17º retorna 503 e capacidade é liberada na desconexão.
- Se o socket avisar backpressure, o servidor espera `drain` com timeout de 3 s; um cliente realmente travado é desconectado, podendo retomar do cursor confirmado. Não há filas infinitas por conexão.
- A rota usa polling da outbox do PostgreSQL, **não** notificação PG, Redis, WebSocket, queue pg-boss, worker S06, servidor Cloudflare ou processo de agentes. Para escala alta será necessário otimizar fanout/observabilidade.
- Somente `127.0.0.1`/loopback; conexão externa bloqueada no startup do servidor. Nenhum token ou senha é incluído nos relatórios Nox.
- `GET /v1/status` e `/openapi.json` são diagnósticos públicos **no localhost**; todos os eventos reais exigem token.
- Não confundir SSE com avanço real de tarefas por modelos de IA: o sistema reflete eventos reais **gravados** no banco, mas os workers ainda usam handler simulado.

## Testes / Critérios

`tests/sse.test.ts`: cursor inválido, 401/403/404, replay histórico, recebimento ao vivo, queda/reconexão, precedência do header, cursor do cliente, limite de conexões, revogação interrompendo stream já aberto e esvaziamento de **515 mensagens** em múltiplas páginas sem lacunas.

`scripts/smoke-sse.mjs`: usa **dois processos distintos da API compilada**. Insere eventos antes, durante e entre conexões, interrompe o primeiro processo, reconecta pelo `Last-Event-ID`, valida a outbox e rejeita token revogado. Incluído em `pnpm run check` quando `DATABASE_URL` aponta para PostgreSQL real.

As evidências canônicas ficam em `.nox/evidence/S08/` fora do repo, incluindo o clone limpo, QA e gates finais.

## Próximos gates

S09 coordenação de ingresso de tarefas entre clientes ChatGPT/VS Code/Codex com origem e idempotência de criação; S10 locks por recurso; S11 integração Git. S07 não implementou login federado/Cloudflare e S08 não o substitui. S15 permanece responsável pela aprovação humana de diffs. **Não publicar o servidor S08 na internet** até os gates de deploy e autenticação adicionais.
