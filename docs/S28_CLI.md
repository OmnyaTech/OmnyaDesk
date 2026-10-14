# S28 — CLI completa (API canônica, sem estado paralelo)

A CLI `pnpm cli` é um cliente **HTTP da mesma API `/v1`** que alimenta o painel Web/desktop. Nenhum comando escreve diretamente em tabelas PostgreSQL, cria aprovação falsa ou acessa arbitrariamente diretórios do operador. Estado de tarefas, eventos e decisões continuam no banco existente, protegidos pelas mesmas permissões, histórico e transações.

## Ambiente

Use PowerShell com um token de projeto, escopado e com validade curta. Nunca cole a credencial em issue, chat, logs ou arquivo versionado:

```powershell
# Obtenha o token pela rotina local de emissão (requer DATABASE_URL segura).
# Apenas no terminal atual; não grave em um arquivo compartilhado:
$secureToken = Read-Host 'Token OmnyaDesk' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try { $env:OMNYA_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$env:OMNYA_URL = 'http://127.0.0.1:4317'
pnpm cli help
pnpm cli projects
```

A CLI rejeita hosts remotos, URLs com credenciais/path, HTTPS externo, redirecionamentos e rotas fora de `/v1`. O token nunca é passado na linha de comando nem exibido em stdout/stderr. `OMNYA_TOKEN` é mantido somente no ambiente do processo; remova-o da sessão com `Remove-Item Env:OMNYA_TOKEN` ao terminar.

Para emitir um token de operador humano de teste, use o provisionamento local já existente (com `DATABASE_URL` na sessão; UUIDs devem ser reais):

```powershell
pnpm token:issue <PROJECT_UUID> <HUMAN_SUBJECT_UUID> human projects:read,tasks:read,tasks:create,tasks:transition,events:read,git:review 1 cli api
```

**Não conceda `git:review` ao token de agente.** Para somente leitura, emita `projects:read,tasks:read,events:read`. O servidor continua impondo escopo, identidade, projeto e validade do token.

## Operações

```powershell
pnpm cli tasks <PROJECT_UUID>
pnpm cli task <PROJECT_UUID> <TASK_UUID>
pnpm cli create <PROJECT_UUID> <OFFICE_UUID> 'Implementar validação' 'Descrição' --key <UUID_UNICO>
pnpm cli logs <PROJECT_UUID> --task <TASK_UUID>
pnpm cli logs <PROJECT_UUID> --after 100
pnpm cli evidence <PROJECT_UUID> <TASK_UUID>
pnpm cli cancel <PROJECT_UUID> <TASK_UUID> 1 'Cancelamento solicitado' --confirm --key <UUID_UNICO>
pnpm cli reviews <PROJECT_UUID>
pnpm cli review <PROJECT_UUID> <INTEGRATION_UUID>
pnpm cli approve <PROJECT_UUID> <TASK_UUID> <INTEGRATION_UUID> 7 <REVIEW_SHA256> --confirm --key <UUID_UNICO>
pnpm cli reject <PROJECT_UUID> <TASK_UUID> <INTEGRATION_UUID> 7 <REVIEW_SHA256> 'Reprovado na revisão' --confirm
pnpm cli changes-requested <PROJECT_UUID> <TASK_UUID> <INTEGRATION_UUID> 7 <REVIEW_SHA256> 'Corrigir os testes' --confirm
```

As aprovações exigem uma revisão Git **já preparada** e validada; `reviewHash` é o SHA-256 de revisão retornado por `pnpm cli review`, diferente do SHA de arquivo comum. Não existe um atalho de `/transitions` para autorizar tarefas: a aprovação passa por `/human-decisions`, que valida ator humano, versão atual, identidade da integração e evidência, gravando decisão, tarefa e outbox atomicamente. A integração Git e o processo de merge continuam exigindo seus próprios controles.

O `--confirm` é obrigatório para operações de cancelamento, aprovação ou rejeição. A versão da tarefa evita alterações sobre estados desatualizados. `--key` fornece idempotência, útil para reenvios após falha de rede. Se omitido, a CLI gera e mostra a chave **antes** de enviar o comando; reutilize-a em qualquer retentativa de resultado incerto. Não reutilize uma mesma chave com conteúdo diferente. Erros HTTP ocultam corpos de resposta não confiáveis e não exibem tokens.

`logs` expõe os eventos **auditáveis** do projeto, paginados via cursor `--after`, não o stdout irrestrito de processos ou a execução shell. `evidence` retorna resumos de evidências imutáveis de uma tarefa. Ambos são somente leitura e seguem ACL por projeto.

## Verificação de contrato

- `tests/cli.test.ts`: valida parâmetros, autenticação e URL somente-loopback, restrições de projeto e escopos, idempotência, criação/listagem/cancelamento sincronizados com API Web e revisão de chamada.
- `tests/cli-review.test.ts`: integração Git real isolada com revisão preparada, identidade humana, hash/versionamento, aprovação atômica, banco, outbox e estado também visto no painel.
- `tests/cli-process.test.ts`: executa o processo Node real `pnpm cli` equivalente em API HTTP loopback e confirma idempotência, mesma tarefa/estado na API e bloqueio de leitura versus escrita.
- `pnpm check`: regressão integral, lint e build.
- `.nox/evidence/S28`: logs de testes, QA, commit público auditado e CI, clone congelado independente.

Nenhum token real é persistido pelos testes; todas as credenciais de prova têm escopo de teste, são criadas no PostgreSQL de QA e não são exportadas para Git.
