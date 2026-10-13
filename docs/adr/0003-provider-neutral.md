# ADR-0003 — Provedor desacoplado e segurança antes de autonomia

**Estado:** aceito para arquitetura inicial.

**Decisão:** `Agent` (identidade/papel) não é `Provider` (modelo/runtime). Adapters implementam contrato comum. Começar com mock e UM runtime real; multi-provedor simultâneo é pós-MVP.

**Restrições:** execução com sandbox de SO/container, worktree, revisão de diff e aprovação humana. Nenhum agente controla política, credenciais ou própria aprovação.

**Consequências:** código inicial ligeiramente mais estruturado, mas reduz dependência de um fornecedor e permite testes determinísticos.
