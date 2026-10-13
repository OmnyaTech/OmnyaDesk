# ADR-0004 — Contratos de domínio e eventos versionados V1

**Estado:** Aceito (S03, 2026-10-11)

## Problema
O protótipo só possui estado em memória e um `OfficeEvent` ad hoc. A introdução de PostgreSQL, múltiplos clientes e workers sem contrato central favoreceria eventos incompatíveis, aprovações indevidas e mudanças de estados inconsistentes.

## Decisão
- Publicar schemas Zod estritos, tipos inferidos, enumerações e um grafo de transições como fronteira compartilhada do domínio.
- Criar um envelope `VersionedDomainEventV1` com `schemaVersion: 1`, IDs, sequência, ator, correlação, origem, tipo e payload discriminado.
- Rejeitar eventos com versões e campos não conhecidos; aprovação e transição para `approved` só são representáveis com ator humano.
- Separar função/papel/skill do agente do modelo LLM, com política explícita de provedores.
- **Não** trocar o formato SSE legado até existir pipeline persistente e estratégia de migração testada.

## Consequências
- Testes do domínio não dependem de DB ou provedor, evitando misturar sprints.
- Dependência versionada `zod` apenas no pacote de contratos.
- Validação de identidade humana efetiva, FK, idempotência, concorrência, imutabilidade e anexos continuam dependentes da implementação do backend (S04 e seguintes).
- Eventos legados e V1 devem coexistir temporariamente, sem cast silencioso.

## Alternativas rejeitadas
- Substituir diretamente o `OfficeEvent` usado pelo mock: quebraria SSE e frontend atual.
- Gerar status válidos só pelo frontend: permite falsificação de progresso.
- Aceitar versões futuras com `passthrough`: ocultaria mudanças de contrato incompatíveis.
