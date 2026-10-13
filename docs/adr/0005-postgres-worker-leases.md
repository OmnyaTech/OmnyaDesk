# ADR-0005 — PostgreSQL worker leases com fencing (S06)

**Status:** Aceito para S06, sujeito a revisão de escalabilidade.

## Contexto
Outbox e FSM S05 são transacionais, mas não havia processo independente para consumir runs com recovery. A solução precisa evitar dois workers confirmando o mesmo efeito de banco, rejeitar workers com leases expirados e permitir retry limitado.

## Decisão
Introduzir `worker_jobs` e `worker_effects` por migration aditiva, um job por `run_id`. Claim com `SKIP LOCKED` e lease/heartbeat; recuperação após TTL; fencing por `lease_token` no commit; cancelamento da tarefa propaga ao job na mesma transação. Handler simulado local para testar infra sem executar agentes.

## Alternativa
`pg-boss` foi considerado conforme o roadmap. Optou-se por implementação restrita com poucas responsabilidades e vinculada ao run existente; custo: necessidade de manutenção/revisão extra antes de workloads reais. Migrar para biblioteca madura se benchmark, disponibilidade ou superfície de erro justificarem.

## Segurança e limites
Marca de resultado único por `run_id` garante deduplicação **somente no banco**, não de chamadas a serviços externos. Não executar shell ou LLM, não expor workers/SQL/API pela internet sem S07. Cancelamento cooperativo não desfaz efeito externo já concluído. Processamento de agentes e efeitos externos exigirá projeto próprio e testes.
