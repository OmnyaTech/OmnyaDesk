# ADR-0006 — Autenticação bearer por projeto no Fastify (S07)

**Decisão:** Aceita para API **local e isolada**, 2026-10-12.

## Necessidade

A API de S04–S06 permitia operações em PostgreSQL sem identificar operador. Com múltiplos clientes e projeto, isso permitiria vazamento de dados, identidade forjada e mudanças indevidas. O mock legado deve continuar somente quando o banco não está habilitado.

## Implementação

- Fastify com contratos JSON Schema e OpenAPI gerado; hook `onRequest` autenticando por padrão `/v1/`.
- Tokens opacos aleatórios de 256 bits, hash SHA-256 em PostgreSQL, validade e revogação. Identidade `human`/`integration`, escopos por operação e projeto fixo.
- Autorização conservadora: nenhum recurso atravessa projeto, corpo não escolhe identidade solicitante; escopo insuficiente 403, token ausente 401.
- Em modo PostgreSQL, rota legada sem autenticação não é montada.
- Provisionamento somente CLI com acesso local ao banco; não há endpoint remoto de criar token ou projeto.
- Aprovação humana suspensa até S15 vincular revisão de diff a identidade confiável.

## Trade-offs

Tokens estáticos não substituem OAuth/SSO, gestão de sessões, identidade federada e MFA. A API permanece vinculada a localhost. Não interpretar testes locais como autorização para Cloudflare Tunnel público. Para produção: auditoria de credenciais, rate-limit, role SQL menos privilegiada, retenção/revogação, autenticação gerenciada e políticas por recurso e tenant.
