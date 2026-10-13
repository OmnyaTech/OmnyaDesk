# ADR-0010 — Fila de integração Git isolada e aprovação por hash (S11)

**Decisão:** Todo merge é mediado por fila persistente PostgreSQL por projeto, usando exclusivamente um repositório bare cadastrado administrativamente. A S11 não atualiza referências em checkouts de desenvolvimento.

O proponente fornece ref SHA imutável e base, validados contra o Git local. O operador prepara a união com `git merge-tree`, executa validadores *read-only* do tree combinado e grava o commit e hash de revisão vinculados ao HEAD. Uma identidade **humana diferente do proponente** aprova o hash exato; apenas então o operador pode atualizar `refs/heads/main` via CAS (`git update-ref`). Uma base/candidate ref alterada invalida a aprovação. O ledger imutável audita cada decisão.

**Motivação:** proteger multi-cliente contra dois merges cegos, Git textual/semântico conflitante e aprovações reaproveitadas. Evitar executar conteúdo não confiável antes das S12/S13. Para reduzir superfícies, os comandos Git são allowlisted sem shell, não executam hooks/scripts e limitam tamanho da árvore.

**Consequências e restrições:** aprovação S11 é específica do merge do bare, não é aprovação genérica das transições FSM S05/S15. Testes conjuntos nesta sprint são estáticos/semânticos (diff check, JSON, registries), **não** execução isolada dos testes de código de terceiros. A S12 proverá isolamento de processo/worktree, S13 ferramentas e testes completos com sandbox; S15 revisões formais de diff para outras ações. A API segue apenas loopback. Tokens humanos emitidos para fixtures não constituem aprovação real de produção. Um cliente que contorne OmnyaDesk e altere Git diretamente só é detectado por divergência do HEAD e CAS, não é governado preventivamente.

**Persistência:** migrations 007 (fila e auditoria) e 008 (escopos Git). Nenhuma migration S01–S10 alterada.
