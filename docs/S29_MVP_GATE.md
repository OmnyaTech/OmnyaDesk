# S29 — Gate MVP funcional: auditoria de produto, segurança e reprodução

## Critério canônico S29-C01
"Entrega real auditável sem regressões críticas" significa que os fluxos autenticados VS Code ↔ API ↔ tarefas/eventos, execução de agente, proposta de diff Git, revisão humana vinculada a bytes/versionamento e exibição do estado permanecem consistentes; scanners e testes não encontram bloqueantes. Não basta screenshot estático nem retornar HTTP 200 em rotas de diagnóstico.

## Matriz GO/NO-GO

| Gate | Evidência exigida | Impede aprovação? |
| --- | --- | --- |
| E2E S29 | Um projeto **descartável** criado via API, task via intake, mock provider determinístico e isolado, candidate SHA e bare Git reais, diff preparado e hash verificado, revisão humana atômica, outbox e evidência íntegros, estado consumível no VS Code somente leitura | Sim |
| Segurança e autorização | Bearer em SecretStorage do Extension Host; GET localhost de projeto autorizado, token ausente no Webview; projeto estranho retorna 404; token leitura não pode aprovar; sem merge por decisão de aprovação | Sim |
| Diff host / Webview | Nova rota de leitura estritamente controlada `/git/integrations`, diff limitado a 24.000 caracteres e passado ao Webview como string; React escapa tags e HTML não executa | Sim |
| Editor real | Instalação **isolada** da extensão no VS Code Windows, ativação por Command Palette e Webview realmente renderizado | Sim |
| Interface e CLI | Regressões WebView2 S24/S25/S27 e VS Code S26, CLI S28; fonte única de dados e histórico de eventos | Sim |
| Testes/build | `pnpm check` PostgreSQL/Ubuntu (253/253 sem skips, 15 smokes), `pnpm s29:browser` e validação nativa | Sim |
| Reprodutibilidade | `pnpm install --frozen-lockfile --offline`, migrations, `pnpm check` em clone privado limpo, testes de navegador e Git sem alterações | Sim |
| Entrega pública | Auditoria pública, Gitleaks, GitHub CI verde em commit correspondente | Sim |
| Revisão de limites | Documentar claramente o que foi demonstrado com mock e o que **não** foi demonstrado com modelo real | Sim |

### Caminho ponta a ponta da evidência S29
1. `tests/s29-mvp.test.ts` executa uma criação de tarefa no endpoint `/v1/projects/:id/intake`; o evento fica em PostgreSQL e é consultável pela extensão do VS Code.
2. `MockProvider` executa de verdade seu contrato de fluxo, com saída determinística, explicitamente **sintética**. O teste transforma essa saída em um commit real num bare Git temporário (não em produção).
3. `GitIntegrationQueue.prepare` verifica branch, base, diff, candidatos, hash e evidência; `GET /v1/projects/:id/git/integrations/:id` devolve um diff autenticado para o VS Code.
4. Um token de leitura não pode aprovar. Só um token humano, autorizado, com hash de revisão e versão corrente, passa por `/human-decisions`. Tudo é transacionado: revisão, tarefa, ator, outbox e audit. Aprovação NÃO faz merge automaticamente.
5. `scripts/smoke-vscode.mjs` testa a extensão real compilada com `LocalReadGateway`, seus filtros, CSP, o Phaser no Chromium e a visualização do diff em React sem execução de HTML malicioso. `scripts/smoke-vscode-editor.mjs` abre uma sessão isolada do VS Code Windows com a extensão recompilada.

### Segurança e limites
- **Sem elevação de privilégios**: o Webview segue sem acesso direto à rede (`connect-src 'none'`) e não recebe token; host aceita somente GET em rotas fixas da API loopback e exige UUIDs autorizados.
- **Diff**: texto não confiável, pode incluir segredos pré-existentes no repositório do próprio projeto; não é enviado a domínios externos. Há tamanho máximo no preview e renderização por React sem `dangerouslySetInnerHTML`.
- **Integridade**: hash do diff preparado e evidência imutável são verificáveis na API; alterações ou revisionamento conflitante bloqueiam aprovação.
- **Isolamento**: testes usam projetos/tokens e bare repositórios descartáveis. Não escrevem em OmnyaFinance, OmnyaLog ou S.P.I.D.E.R.
- **Não demonstrado**: uma tarefa iniciada *pelo botão do VS Code* (o Webview atual permanece somente leitura), nem um novo trabalho ao vivo de Codex nesta S29. O teste usa o adaptador MockProvider e um commit fixture produzido pelo teste; o pilot live do S17 é evidência histórica, não uma prova desta S29.
- **Escopo futuro**: interface pixel art detalhada, múltiplos monitores físicos, recursos econômicos/cidade e infraestrutura Docker dedicada S30+ não pertencem a este gate MVP.

## Artefatos
- Código: `apps/vscode/src/{protocol.ts,extension.ts,webview.jsx,webview.css}`
- Prova de fluxo: `tests/s29-mvp.test.ts`
- Reprodução: `pnpm s29:browser` (Windows/Edge), `node scripts/smoke-vscode-editor.mjs` (Windows/VS Code), `pnpm check` (PostgreSQL/Ubuntu).
- Logs/aceite: `.nox/evidence/S29/`; o Nox só avança para S30 após todos os gates documentados como PASS.

**Política Go/No-Go:** No-Go para alegações de produção com Codex ao vivo ou disparo de tarefas diretamente pelo VS Code. GO para o **MVP limitado e auditável** de acompanhamento, revisão de diff e aprovação humana pela API/CLI com compatibilidade de VS Code somente leitura, sujeito aos gates técnicos acima.
