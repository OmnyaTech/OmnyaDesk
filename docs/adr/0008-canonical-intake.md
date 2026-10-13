# ADR-0008 — Ingresso canônico e proveniência por token (S09)

**Status:** Aceito para protótipo local S09.

## Contexto
Clientes técnicos distintos (ChatGPT, Desktop Commander, Codex, VS Code) precisam criar tarefas no mesmo ledger sem duplicação por retry, sem declarar identidades arbitrárias nem contornar autorização. O sistema já tem tokens locais S07, eventos/outbox S05 e worker sintético S06.

## Decisão
Uma `TaskIntakeService` transacional compartilha ingressos Fastify `/intake` e `/tasks` e uma ferramenta MCP stdio oficial que chama a mesma API. Todo POST HTTP externo exige `Idempotency-Key` UUID; o MCP exige argumento equivalente. A origem e o canal são vinculados ao token no banco (aprovisionamento local), nunca escolhidos pelo payload. A migração 005 registra recibo original, fingerprint, ator, origem, canal e token junto ao taskId e eventId.

## Consequências
- Retransmissões de igual chave/solicitante/payload retornam resposta original, sem duplicar evento/outbox; payload diferente vira 409.
- Identidade/projeto/escopo são checados por token e validados na transação.
- Não há lock por repositório/worktree; S10/S11 continuam necessários.
- `client_origin` é identidade administrativa registrada no token, **não atestado do binário chamador**.
- SDK MCP apenas adaptador local; conexões finais do ChatGPT e VS Code permanecem planejadas S24/S34–S36. Sem deploy, Cloudflare ou publicação.
