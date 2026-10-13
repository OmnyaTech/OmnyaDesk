# ADR-0011 — Worktree Git por execução + WSL2 usernamespace sem privilégios (S12)

**SUPERSEDED / REJEITADO PARA OMNYADESK:** o usuário definiu Ubuntu Server como destino obrigatório; ver [ADR-0012](0012-ubuntu-ssh-docker-worktrees.md). Este arquivo registra somente a decisão histórica, sem autorização para executar a S12 em WSL2.

**Decisão:** não ligar o Docker Desktop local, pois estava parado e iniciá-lo poderia acionar containers de outras aplicações. O Windows Sandbox gráfico está habilitado mas não foi possível provar sua execução automática (encerrou sem arquivo de prova); foi rejeitado como critério de aceite. O Linux WSL2 existente permite `unshare` de usuário, mounts, processos, rede, IPC e UTS e remoção total de capacidades. Combinaremos esse mecanismo com tmpfs/chroot/ro bind mount de snapshot extraído exclusivamente de um worktree Git de tarefa registrado no PostgreSQL.

**Provas:** o guest demonstrou CapEff=0, NoNewPrivs=1, rede ausente, host-isca invisível/inalterado, workspace somente leitura e mount sem privilégios; duas tarefas mantiveram worktrees distintos, 12 candidatos concorrentes à mesma tarefa resultaram em 1 único ativo e junção NTFS externa foi recusada. Os testes de clone e regressão deverão reproduzir os gates.

**Trade-offs:** dependência do WSL2 e da distribuição Linux instalada, rootfs mínima BusyBox (não suite completa de build de projeto), kernel WSL compartilhado, sem seccomp personalizado. O snapshot é somente leitura e não inclui `.git`, segredos locais ou diretórios pessoais. S13 irá adicionar gateway allowlist de ferramentas e políticas operacionais adicionais; S15 revisará aprovações de diff. Não alegar que agentes externos acessando Git diretamente obedecem aos locks S10/S11/S12.

**Persistência:** migration 009 versionada; nenhum arquivo de migration anterior alterado. Sem mudanças em Docker/Cloudflare ou em apps do servidor.
