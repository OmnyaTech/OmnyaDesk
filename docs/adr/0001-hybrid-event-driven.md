# ADR-0001 — Hybrid + Event-driven

**Estado:** aceito para arquitetura inicial.

**Contexto:** agentes precisam existir independentemente da UI e do modelo, com operação no VS Code, CLI e web.

**Decisão:** uma API e um orquestrador central possuem os estados. O visualizador consome eventos imutáveis e deriva animações. Não permitir que personagens mudem o estado de negócio diretamente.

**Consequências:** facilita troca de modelos e visualizações e auditabilidade. Exige modelagem de eventos, política de idempotência e persistência transacional antes de executar operações reais.
