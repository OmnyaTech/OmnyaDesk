# ADR-0007 — SSE com replay de outbox persistente (S08)

**Status:** aceito para cliente local e testes de escala pequena.

## Contexto
Os eventos V1 e a outbox S05 são gravados atomicamente, e os tokens S07 permitem leitura por projeto. Um cliente externo à lógica de execução precisa receber mudanças sem perder histórico depois de cair ou reiniciar a API.

## Decisão
- Endpoint Fastify SSE autenticado usando `task_outbox.id` como ID de mensagem.
- Reidratação e live via mesmo loop de polling, sem janela entre subscription e replay. O cursor avança estritamente após transmissão; header `Last-Event-ID` e query `after` suportados (header vence).
- Cliente responsável por confirmar/processar e persistir cursor por projeto; helper `ReplayCursor` valida envelope V1 e descarta mensagens antigas/duplicadas.
- Limite 16 conexões/instância; backpressure com espera limitada de `drain`, fechamento e replay; heartbeat e revalidação de token revogado.

## Consequências
Confiabilidade **at-least-once** por replay persistente; exatamente uma aplicação de UI requer idempotência do consumidor, não garantia do socket. O polling PostgreSQL a cada ~150 ms favorece simplicidade/testabilidade, mas não é fanout de produção; revisar LISTEN/NOTIFY, Redis ou broker se volume exigir. SSE com header Bearer exige `fetch` streaming, não `EventSource` sem header. Sem deploy remoto ou rotas públicas. Não altera a ordem de events/outbox da S05.
