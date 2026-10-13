# ADR-0012 — Ubuntu Server por SSH e Docker efêmero como sandbox da S12

**Status: ACEITO — substitui ADR-0011 (WSL2; não aprovado para o produto).**

O usuário definiu explicitamente `ssh ubuntu-builder` como destino obrigatório de execução. A solução anterior com WSL2 local passou em testes isolados, mas usava a infraestrutura errada e seu aceite S12 foi revogado. No novo desenho a CLI mantém controle no developer-workstation/DB local e executa Git worktrees **no Ubuntu Server**, transferindo os objetos Git imutáveis via SSH/SFTP. A chave privada permanece no agente do Windows; a sessão valida fingerprint da chave pública do host SSH.

A execução só ocorre com container Docker Alpine limitado por digest, `--pull never`, rede nenhuma, rootfs somente leitura, mount único do worktree em read-only, usuário nobody, todas as capabilities removidas, no-new-privileges, seccomp/AppArmor padrão, 128 MiB RAM, meio CPU, 32 PIDs e limite de 19 segundos. Containers temporários são exclusivos por `runId` e removidos no `finally`. Proibido Docker prune, Docker socket para o candidato, sudo, alteração de Compose ou compartilhamento de diretórios de outros projetos.

**Verificações de aceite:** testes reais no Ubuntu Server: contenção de host-isca, sem rede, sem escrita no volume, sem montagens privilegiadas; concorrência por projeto, recusa de worktree sujo, inspeção efetiva do Docker e timeout; regressão local em clone Git independente e evidências Nox. Nada disso equivale a controle completo de ferramentas (S13) ou à garantia contra vulnerabilidades do kernel.

**Histórico:** ADR-0011 permanece como registro da abordagem descartada, sem runtime WSL2 ativo no código corrigido. Migração 009 foi preservada imutável, enquanto migration 010 rotula worktrees remotos. Nenhum servidor fora do Ubuntu Server fornecido pelo usuário é utilizado.
