# ADR-0013 — Gateway deny-by-default com leases S10 e Ubuntu Docker S12

**Status: ACEITO para S13 local, sujeito às provas automáticas finais.**

Decidiu-se usar ferramentas tipadas e imutáveis em vez de expor shell ou `git -C` com argv livre. `UbuntuToolGateway` valida cada requisição por schema estrito, revalida o recurso autorizado pela lease S10 com workerId/token/fencing, escopa a execução ao único worktree remoto S12 e aceita apenas Git somente leitura, operações limitadas de arquivo (helper Linux com openat/no-follow, CAS, flock) e execução de uma suíte `entry` dentro do container Docker S12.

A integração que modifica commits canônicos permanece **exclusiva** da fila S11 e de aprovação humana. O CLI `worktree run` foi removido para evitar execução fora da lease; o CLI `tool` recebe apenas um JSON de solicitação permitida. Não há rota HTTP para tool execution. Uma conexão SSH2 fixada por fingerprint reutiliza a chave do agente Windows, com encerramento correto de canais SFTP.

Deny-by-default foi escolhido para reduzir a área de ataque: sem comandos shell arbitrários, Docker.sock, merge/commit/push arbitrários, paths externos, dotfiles, symlinks, arquivos executáveis, network ou remoção de outros containers. Filesystem de escrita só via helper confiável em worktree de cada run; teste é somente em Docker com read-only root e workspace.

**Limites:** Linux Docker compartilha kernel, o controlador SSH continua privilegiado no host, e lease revogada durante a escrita não desfaz efeito já ocorrido. O CAS e os logs posteriores reduzem risco, mas não substituem auditoria de S14 e revisão/aprovação de S15. O executor continua local do ponto de vista da API e não foi publicado no Cloudflare.

Ver [docs/TOOL_GATEWAY.md](../TOOL_GATEWAY.md) e [ADR-0012](0012-ubuntu-ssh-docker-worktrees.md).
