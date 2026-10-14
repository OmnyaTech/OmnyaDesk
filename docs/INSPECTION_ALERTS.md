# S23 — Inspeção de agentes e alertas de intervenção

## Objetivo
O operador pode selecionar uma estação no escritório Phaser e abrir diretamente os detalhes da tarefa autenticada relacionada a ela, incluindo eventos persistidos e resumos de evidências. Situações que exigem atenção aparecem no painel sem inferir progresso dos sprites.

## Interação
- Clique no avatar Phaser (somente quando o SSE estiver online) abre a tarefa principal mapeada à estação pela projeção S22; tarefas sem vínculo não abrem detalhes.
- O botão acessível `Inspecionar tarefa e logs` nas estações abre os mesmos detalhes, inclusive quando a conexão SSE estiver temporariamente indisponível (dados persistidos já carregados).
- Os detalhes mostram status, versão, identificador, execução, eventos e hashes do ledger consultados da API autenticada. Nunca exibem segredos nem saída bruta de provedores.
- Alertas aparecem apenas para status `awaiting_approval`, `blocked`, `failed` e `changes_requested` do snapshot `/tasks` autenticado. A ação abre a tarefa e suas evidências. Não dispara aprovação, integração ou transição.
- As permissões seguem os escopos `projects:read`, `tasks:read` e `events:read`; as aprovações humanas continuam exclusivas do fluxo S15 (`git:review` e `tasks:transition`), com hash imutável, ator distinto e autorização do servidor. A interface é **somente leitura**.

## Segurança e limites
- Nenhum novo endpoint, credencial persistente, CORS permissivo, biblioteca externa ou capacidade de execução é introduzido.
- O mapeamento de estação usa `projectOffice` e `projectId` canônico. SSE offline suspende animação; estado e alertas só mudam após reidratação do backend.
- Caso existam várias tarefas para a mesma estação, o avatar abre a tarefa primária mais recente conforme a projeção existente; a lista e a área de alertas permitem selecionar outras.
- Logs exibidos são entradas de eventos e resumos SHA-256 das evidências disponíveis na API. A aplicação não concede acesso ao conteúdo bruto do ledger nem aprova alterações.
- O seletor nativo de pastas do Windows e autenticação única continuam previstos em S24-C02; não pertencem a esta sprint.

## Regressão e aceite
- `pnpm check`: lint, typecheck, testes com PostgreSQL, build e smokes compilados; casos S12/S13 exigem Ubuntu SSH configurado para **zero skips**.
- `node scripts/smoke-operator-browser.mjs`: Playwright headless em navegador real, incluindo clique no avatar, botão por estação, alerta apenas sob status persistido, abertura de evidência SHA e bloqueio de autoaprovação, além das verificações S20–S22.
- Clone Git independente com `pnpm install --frozen-lockfile --offline` + migrations + `pnpm check`, QA e scanner de segredos antes de publicar.
