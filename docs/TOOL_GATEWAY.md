# S13 — Gateway de ferramentas autorizado, execução exclusivamente no Ubuntu Server

## Contrato (dois itens do sprint)

- **S13-C01 — Gateway Git/arquivos/testes:** `UbuntuToolGateway` implementa uma fronteira única para ferramentas propostas por agentes. Toda requisição tem `projectId`, `taskId`, `runId`, `workerId`, `leaseToken` e `fence`; todos obrigatórios. O gateway **não** é um shell remoto, não recebe comandos/argv livres e não aceita mutação Git.
- **S13-C02 — Política deny-by-default:** operação e argumentos são validados por Zod estrito antes de SSH; paths só podem ser relativos, ASCII permitido, sem `..`, `.` intermediário, `/` inicial, `\\`, nomes ocultos, `-option`, `.git`, `.env`, `node_modules`, `dist`, `entry.sh`, extensão executável, codificação ambígua ou command substitution. Operações com recursos insuficientes ou lease S10 expirada/fenced são bloqueadas. Limites de payload, resposta e execução são fixos.

## Ferramentas permitidas

| `tool` | Campos específicos | Política |
|---|---|---|
| `git.status` | nenhum | Git read-only no worktree S12, recurso `repo` com lease read/write |
| `git.diff` | `path` opcional e permitido | Diff sem executável externo, recurso `repo` read/write |
| `files.list` | `path` (padrão `.`) | Até 100 entradas; recurso read/write `repo` ou `path:<prefixo>` |
| `files.read` | `path` | Só arquivo UTF-8 regular; até 16 KiB; recurso read/write daquele path |
| `files.write` | `path`, `content`, `expectedSha` | Só conteúdo UTF-8 até 16 KiB, extensão textual permitida; recurso **write**, compare-and-swap SHA-256 ou `absent` |
| `tests.run` | `suite: "entry"` | Executa somente `entry.sh` do worktree no Docker S12. Recurso `repo` read/write; 19s max, 128MiB, 0.5CPU, 32PIDs, rede desativada |

**Qualquer outra operação é rejeitada antes de gerar comando SSH.** A API de integração Git/merge da S11 permanece independente, transacional, serializada, com revisão humana e comparação de hash; **não** existe `git.commit`, `git.add`, `git.push`, `git.merge`, `docker.exec` ou `shell.exec` no gateway.

## Autorizações e escopo

O gateway consulta o PostgreSQL S10 para verificar, no momento da operação, o estado `scheduled_tasks=running`, o `workerId` associado, o `leaseToken` UUID, o `fence` monotônico, `lease_until` futuro e o recurso registrado em `resource_leases` com mesmo fence. A reserva precisa ter margem de 6s para arquivos/Git e **28s** para teste Docker (19s+timeout/cleanup). O worktree deve existir em `execution_worktrees` com `state=ready`, `execution_backend=ubuntu_ssh_docker`, mesmo projeto/tarefa, host e caminho UUID determinístico. Após cada execução, a lease é revalidada; para testes longos, verifica-se que não foi revogada nem substituída antes de devolver sucesso.

O escopo `repo` abrange o repositório, mas `path:docs` autoriza somente caminhos `docs/...`, não `docs-other` nem `README.md`. Uma lease com modo `read` **nunca** permite `files.write`.

**Risco conhecido de revogação simultânea:** como a execução acontece por SSH e não num lock transacional até o fim, uma lease pode expirar enquanto uma gravação rápida já estiver concluindo. O resultado é rejeitado na pós-validação, mas o efeito pode ter ocorrido; não é correto declarar rollback/exactly-once nessa janela. O compare-and-swap SHA, o bloqueio `flock` por diretório e o Git diff auditável limitam perdas. S14 inclui auditoria de artefatos e S15 aprovações; operadores devem manter heartbeat até encerramento do job.

## Segurança operacional no servidor

`scripts/remote-tool-files.py` é um **helper confiável**, enviado por SFTP para um arquivo aleatório exclusivo dentro do diretório privado daquele run, fora do volume montado no container. Nenhum trecho shell do usuário pode definir seu código. Esse helper usa `openat` ancorado no root do worktree, `O_NOFOLLOW`, `O_DIRECTORY` e `O_NONBLOCK` para bloquear symlinks/junctions, FIFOs e escape por pais. Escrita usa `flock` do diretório, compara SHA-256 do conteúdo existente, escreve temporário com permissão 0600, faz `fsync` e `rename` atômico relativo ao mesmo diretório. O arquivo auxiliar é apagado em `finally`; o canal SFTP também é encerrado a cada transferência para não atingir `MaxSessions` do SSH.

O `UbuntuDockerSandbox` existente da S12 executa o único teste admitido, com nome e label exclusivos, sem rede/sock Docker, filesystem somente leitura, usuário `65534`, capabilities removidas, seccomp, limite de CPU/RAM/PIDs e timeout, seguido de `docker rm` somente daquele container. **Nenhum** comando `docker prune`, Compose, Cloudflare, firewall, sudo ou atualização do host faz parte do S13.

`worktree run` no CLI anterior **foi removido**: um operador precisa passar pelo gateway com claim S10 para acionar o teste. APIs públicas ainda **não** expõem esse gateway e o controle de workflow/diff/artefatos de produção será amadurecido nas próximas sprints. A biblioteca S12 interna continua disponível a testes e componentes confiáveis e não constitui autorização para executá-la de uma origem pública.

## CLI local do operador

Com o banco PostgreSQL local já configurado e a chave SSH carregada no agente do Windows:

```powershell
$env:OMNYA_S12_REMOTE_CONFIG = "$HOME\omnyadesk-private\remote-config.json"
# DATABASE_URL configurado localmente com segredo mantido fora de scripts/logs.
# A tarefa já deve estar registrada e claimed no ResourceScheduler da S10,
# com worktree S12 READY e lease válida, >=28s para tests.run.
pnpm run tool -- C:\Temp\s13-tool-request.json
```

Exemplo de conteúdo do arquivo *local* de requisição:

```json
{
  "projectId": "<UUID do projeto>",
  "taskId": "<UUID da tarefa>",
  "runId": "<UUID do worktree S12>",
  "workerId": "<identidade do worker S10>",
  "leaseToken": "<UUID do claim S10>",
  "fence": 1,
  "tool": "files.read",
  "path": "README.md"
}
```

Esses valores são **exemplos**, não tokens reais. Proteja e apague o JSON local após a execução, pois o leaseToken autoriza operações. Para testar a política, prefira o script automatizado e não inserir informações confidenciais em logs.

## Gates de aceite

`tests/tool-gateway.test.ts` realiza provas no Ubuntu Server: bloqueio de comandos Git mutantes/shell, paths absolutos e traversal, recurso `repo` vs subdiretório, ACL read/write, projeto/tarefa/run/worker/lease/fence, leases expiradas, symlinks apontando para host, escrita CAS concorrente, Git status/diff e teste Docker real. `scripts/smoke-tool-gateway.mjs` repete pelo código **compilado** e exige resposta do Ubuntu com 16 verificações independentes. No aceite local e clone independente, exportar `OMNYA_S13_REQUIRED=1` e `OMNYA_S12_REQUIRED=1` para impedir skips de integração.

Sem exposição remota de nenhuma nova rota de API; o S13 acrescenta a porta de ferramentas **apenas na CLI local autorizada**. Nenhum deploy de serviço permanente.

## Recuperação de worktree após falha do controlador

Durante a QA foi identificado um worktree sintético READY deixado por uma execução antiga interrompida. A cópia Git canônica de teste já havia sido descartada localmente, então o fechamento remoto dependente da origem era indevidamente bloqueado. O método RemoteWorktreeManager.close mantém agora as verificações de projeto, runId, host, estado e limpeza do checkout remoto, mas **não exige que o repositório local de origem ainda exista**. A criação de novos worktrees continua exigindo a origem válida. Um teste real no Ubuntu remove propositalmente a origem de uma fixture e confirma que somente seu worktree remoto limpo pode ser encerrado. A fixture antiga também foi encerrada usando a CLI do próprio OmnyaDesk, sem remoção forçada. Não se aplica fechamento automático de worktrees sujos.
