# S11 — Fila única de integração Git, revalidação e aprovação humana

**Escopo aprovado:** (1) fila única com base Git, versionamento, verificação de divergência e conflito; (2) validação do resultado **combinado** e aprovação explícita vinculada ao hash antes de integrar. A implementação é **local**, apenas para repositórios **bare** dedicados. Não foi ativada no repositório de desenvolvimento OmnyaDesk, que continua com checkout normal.

## Fluxo

```text
ChatGPT / Desktop Commander / Codex / VS Code (via ingresso autenticado S09)
       |
  Git proposal: taskId, candidateRef, candidateSha, baseSha, priority
       |    (Git ref deve apontar exatamente ao SHA proposto)
       v
PostgreSQL git_integration_requests + audit imutável
       |
  prepare (token git:integrate) -- transação + lock por projeto
       |   merge-tree no bare, sem checkout nem alterar main
       |   testes seguros no tree COMBINADO, hash de revisão
       v
   READY com targetHead+candidateSha+testedTree+plannedCommit+reviewHash
       |
  approve (token humano com git:review; diferente do proponente)
       |   compara revisão/hash/HEAD/ref exatos
       v
  integrate (token git:integrate, CAS no ref main)
       |   HEAD e branch rechecados, nenhuma aprovação automática
       +-- mudou? STALE, exige re-prepare, testes e nova aprovação
       +-- conflito? CONFLICT ou TESTS_FAILED, nenhuma alteração
       v
  MERGED — commit composto com pais [HEAD,CANDIDATE] e audit
```

O commit de integração é criado como **objeto não referenciado** na fase de preparação; o `main` do bare só é movido após aprovação, com `git update-ref refs/heads/main plannedCommit expectedHead` (*compare-and-swap*). Isso impede sobrescrita de uma atualização concorrente e não modifica pastas de trabalho. A operação é serializada por projeto com advisory lock de transação PostgreSQL; commits externos no Git são protegidos pela checagem CAS.

### Por que somente repositório bare?

Atualizar `main` diretamente por `update-ref` num checkout normal poderia divergir o índice/working tree. A S11 **rejeita esse cenário** e exige um bare cujo `repository_root` seja cadastrado administrativamente no projeto. Uma futura ponte com worktrees físicos e isolamento pertence às S12–S13. **Não editar `projects.repository_root` para apontar para o checkout atual.**

## Endpoints locais

- `POST /v1/projects/:projectId/git/integrations` — `git:propose`, JSON `{taskId, candidateRef, candidateSha, baseSha, priority?}`, HTTP 201.
- `POST /v1/projects/:projectId/git/integrations/:id/prepare` — `git:integrate`, retorna `state:ready` com `reviewHash`, `testedTree`, `targetHead` e checks, ou `conflict`/`tests_failed`.
- `POST /v1/projects/:projectId/git/integrations/:id/approve` — `git:review` e token com `kind=human`, JSON `{reviewHash}`, exige que a mesma revisão ainda seja válida.
- `POST /v1/projects/:projectId/git/integrations/:id/integrate` — `git:integrate`, exige aprovação válida. Em `stale`, HTTP 409. Nunca integra automaticamente.
- `GET /v1/projects/:projectId/git/integrations` e `GET /v1/projects/:projectId/git/integrations/:id` — escopo `tasks:read`.

A política de prioridade impede preparar uma proposta enquanto existe outra de maior prioridade ainda na fila e impede integrar uma proposta aprovada atrás de outra aprovada de maior prioridade. As propostas bloqueadas não impedem a fila de avançar indefinidamente, mas necessitam revisão/retrabalho explícito.

**Segurança:** tokens são emitidos administrativamente com os novos escopos `git:propose`, `git:review` e `git:integrate` (migration `008_git_token_scopes.sql`). O corpo HTTP **não pode escolher** o revisor. O backend recupera identidade e escopo do token. Um token de integração, mesmo contendo `git:review`, **não pode** aprovar. O autor da proposta também não pode aprová-la; exige outro humano. Nenhuma aprovação é deduzida do sucesso dos testes. Não expor bearer ou caminhos de repo em logs/screenshot.

## Testes conjuntos — limite da S11

O resultado combinado é validado por um conjunto de **testes embutidos de leitura**, aplicados ao Git tree antes de qualquer merge:

1. `git diff --check` contra o target atual;
2. tipos de arquivo e limites de tamanho/contagem (rejeita symlink, submodule, arquivos executáveis e `.gitmodules`);
3. parser JSON de todos os arquivos `.json`;
4. verificação de IDs únicos em `integrations/registry.json` e nos shards `integrations/registry/*.json` — detecta conflito semântico entre branches que o merge textual aceitaria.

Os testes são executados **sobre o conteúdo combinado**, não sobre cada branch isolada, e repetidos quando a base muda. O `reviewHash` SHA-256 cobre ID da solicitação, base declarada, targetHead, candidateSha, merged tree e a versão dos testes; portanto a aprovação não pode ser reutilizada após mudanças.

**Importante:** deliberadamente **não** executamos `npm test`, `pnpm`, scripts da branch, hooks Git nem processos vindos de código não confiável na máquina do usuário. A execução segura desses testes de software completos requer isolamento de SO/FS da **S12** e allowlists da **S13**. Este escopo da S11 valida integração textual, estrutural e semântica definida pelo contrato, não prova que qualquer código arbitrário compila ou roda. Mesmo com testes passando, revisão humana de semântica e segurança é obrigatória.

## Provas e regressões

`tests/git-integration.test.ts` utiliza somente repositórios bare e clones de trabalho **descartáveis**, com duas branches geradas no teste: conflito de texto, proposta independente, conflito semântico após união, prioridade, cross-project, identidade humana inválida, divergência do HEAD/ref, reinício de pool e audit imutável.

`scripts/smoke-git-integration.mjs` valida por HTTP contra a API **compilada**, incluindo autenticação, propostas de dois clientes, aprovação humana simulada em fixture, rejeição, restart da API, revalidação e atualização atômica de bare. Está incluído em `pnpm run check` quando DATABASE_URL está configurado.

Todas as aprovações feitas pelos testes são **fixtures sintéticas de QA**, não autorização humana para integrar alterações no repositório do usuário. Nenhuma alteração nos projetos OmnyaFinance, OmnyaLog, S.P.I.D.E.R. ou nos containers/túneis do servidor. A interface pixel e modos desktop continuam em sprints futuras.
