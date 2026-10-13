# S12 (revisada) — Ubuntu Server, Git worktrees remotos e Docker isolado

**Situação:** implementação destinada exclusivamente ao Ubuntu Server `ubuntu-builder`, acessado por SSH. **Nenhuma execução por WSL2 no PC** faz parte do runtime aprovado. Esta especificação substitui a abordagem histórica do ADR-0011.

## Contrato de arquitetura

O Windows mantém a API/contratos/ledger PostgreSQL local do protótipo. A execução do trabalho usa o Ubuntu Server. A CLI solicita a criação de workspace por tarefa, obtém a cópia Git de um commit registrado e depois pede execução dentro de um container Docker temporário no servidor. A API pública ainda não pode iniciar essas operações automaticamente (gateway/regras de S13).

- **Transporte:** `UbuntuSshTransport` usa SSH2 por TCP/22 e **a identidade do servidor é validada pelo fingerprint SHA-256 configurado**, não por `StrictHostKeyChecking=no`. No developer-workstation o SSH2 consulta diretamente o agente Windows OpenSSH por named pipe. A chave privada não é exportada, copiada nem gravada em arquivos do aplicativo. Não há exposição do Docker Remote API nem abertura de portas.
- **Fonte canônica:** `projects.repository_root` continua o repositório Git confiável registrado no PostgreSQL pela S11. O OmnyaDesk verifica que o objeto de base é um commit Git válido, que a árvore está dentro dos limites e não contém symlink, arquivo executável, submódulo, `.env`, `.ssh`, `.gitmodules` ou caminhos inseguros. Gera um Git bundle temporário **estritamente do commit solicitado e de seus ancestrais**, limitado a 64 MiB, transmitido por SFTP ao servidor (sem compartilhar credenciais). Uma branch privada não relacionada, mesmo presente no repositório de origem, não é transferida. Um teste com commits distintos inspeciona o bare remoto e demonstra a ausência do objeto da outra branch.
- **Origem Git no Ubuntu:** por execução, uma pasta UUID sob `/home/developer/.local/share/omnyadesk/s12/projects/<projectId>/<runId>/` contém `source.git` bare e `workspace` (Git worktree). A branch é `omnyadesk/s12/<runId>`, com commit base imutável, também registrado em `execution_worktrees`. A migration 010 marca backend `ubuntu_ssh_docker`, host remoto e digest da imagem; registros históricos de S12 local/WSL ficam `legacy_local` (auditoria, não runtime).
- **Concorrência:** advisory lock PostgreSQL e índice de exclusividade por `(project_id,task_id)` permitem no máximo um worktree ativo por tarefa. Duas tarefas diferentes possuem branches e pastas distintas; o Git do OmnyaDesk e o checkout do usuário não são modificados.
- **Fechamento:** recusa worktree com alterações não commitadas (não força exclusão). A remoção afeta exclusivamente o `runId` autorizado. O ledger da tarefa passa a `closed` com timestamp. Em falha de execução, o container recebe nome exclusivo e é removido no `finally`, sem `docker prune` nem comandos globais.

## Política Docker da S12

Executor: `UbuntuDockerSandbox`. Para cada execução `entry.sh` será iniciado em Alpine oficial **já presente no cache** e referenciado pelo seu digest `alpine@sha256:...`, com `--pull never`. Os controles são aplicados pelo Docker 29.8.1 do Ubuntu Server:

| Controle | Regra |
|---|---|
| Rede | `--network none` |
| Filesystem | `--read-only`; somente `workspace` no bind `readonly`; `/tmp` em tmpfs de 8 MiB, `nosuid,nodev,noexec` |
| Identidade/capacidades | `--user 65534:65534`, `--cap-drop ALL`, `--security-opt no-new-privileges` |
| Processos/CPU/RAM | `--pids-limit 32`, `--cpus 0.5`, `--memory 128m` |
| Segurança do host | seccomp padrão e perfil AppArmor do Docker, PID/IPC isolados |
| Prazo | `timeout -k 2 19`; saída controlada e remoção adicional exclusivamente do container S12 nomeado |
| Acesso externo | sem socket Docker dentro do container; sem volumes de OmnyaFinance, OmnyaLog, S.P.I.D.E.R. ou diretórios pessoais |

**Atenção:** o usuário SSH do servidor tem acesso ao grupo `docker`; portanto o **controlador** (fora do container) tem privilégios amplos no Docker, mas os scripts `entry.sh` não recebem socket/credencial/volumes desse controlador. A S13 deverá impor políticas adicionais para impedir que solicitações de clientes executem comandos de controle arbitrários. Containers isolados não eliminam todos os riscos de vulnerabilidades de kernel/Docker.

## Como executar localmente via developer-workstation

Configure variáveis **apenas no seu terminal local**, com os arquivos de runtime privados previamente provisionados:

```powershell
# Dentro da pasta-fonte OmnyaDesk, com DATABASE_URL do cluster local disponível:
$env:OMNYA_S12_REMOTE_CONFIG = "$HOME\omnyadesk-private\remote-config.json"

pnpm run worktree -- create <project_uuid> <task_uuid> <base_commit_sha40>
# Leia runId e checkoutPath remoto no JSON retornado.
pnpm run worktree -- get <project_uuid> <run_uuid>
pnpm run worktree -- run <project_uuid> <run_uuid>
pnpm run worktree -- close <project_uuid> <run_uuid>
```

O arquivo `remote-config.json` guarda host, usuário SSH, fingerprint público, caminho da pasta de trabalho e digest de imagem; **não** contém senhas/chaves privadas e permanece fora do Git. A chave SSH só é utilizada pelo agente OpenSSH. No host Unix, uma implementação futura pode empregar outro socket de agente compatível, sem alterar este contrato.

## QA e provas obrigatórias

Os testes da S12 usam um projeto Git sintético com duas branches e PostgreSQL real. Verificam 12 candidatos concorrentes à mesma tarefa, isolamento entre worktrees, rejeição de SHA/tenant/árvore suspeita, recusa de fechamento sujo, teste com arquivo-isca no Ubuntu fora do único volume permitido, tentativa de escrita no workspace, uso de rede, montagem dentro do container, ausência de socket Docker, CapEff=0, NoNewPrivs=1 e seccomp ativo. Testes adicionais inspecionam os limites reais em `docker inspect` enquanto o container roda e verificam timeout e ausência de containers remanescentes. Smoke `scripts/smoke-sandbox.mjs` executa 16 verificações via código compilado.

As provas **devem** ser realizadas no servidor `ubuntu-builder` para aceite; êxito apenas em WSL2 não constitui evidência. `pnpm run check` inclui o smoke e pode pular testes remotos quando a configuração falta em outro ambiente; durante homologação, use `OMNYA_S12_REQUIRED=1` e inclua as variáveis do servidor para proibir skips.

## Dependências futuras e não interferência

S12 implementa worktrees e execução *do script do candidato* dentro do Docker, mas ainda não é um tool gateway geral. S13 deverá aplicar allowlist por operação, integração mandatória de leases S10/Git S11 e políticas mais abrangentes. A API S07 permanece restrita a localhost. A segunda referência visual de escritório pixel art continua planejada para as sprints de UI.

**Não houve deploy do OmnyaDesk como serviço persistente**, alteração de stacks Compose, Cloudflare, OmnyaFinance, OmnyaLog ou S.P.I.D.E.R. O Docker do Ubuntu Server foi somente consultado e recebeu containers S12 efêmeros com nome/label exclusivos.
