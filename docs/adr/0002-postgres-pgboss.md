# ADR-0002 — PostgreSQL + pg-boss

**Estado:** aceito para arquitetura inicial; verificar compatibilidade final na instalação.

**Contexto:** workloads multiagentes são longos, podem falhar e exigem retry, histórico e aprovação humana.

**Decisão:** PostgreSQL armazena agregados, eventos, aprovações, artefatos e outbox; pg-boss cuida de jobs duráveis no mesmo banco. API não roda o trabalho pesado de LLM dentro de requests HTTP.

**Consequências:** menor footprint inicial que Postgres+Redis, mas atenção a pool de conexões, idempotência e gestão de recursos. Escalar para outros brokers apenas se métricas justificarem.
