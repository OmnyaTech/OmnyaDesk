# S22 — Eventos persistidos projetados no mundo Phaser

## Contrato de aceitação

Sprites **refletem o estado persistido do projeto autenticado**, com projeção determinística do histórico de eventos, sem inventar avanços de execução. O painel é somente leitura e não autoriza ações, Git, modelos, aprovações ou acesso fora do projeto.

### Fonte de verdade e replay

`/v1/projects/:id/tasks` fornece os estados canônicos persistidos no PostgreSQL, e `/v1/projects/:id/events?after=N` fornece o histórico ordenado por sequência. O cliente percorre páginas de 500 eventos, no máximo 3000 eventos por atualização; se atingir esse teto, exibe **histórico parcial** e não afirma ter reconstituído toda a sequência. Não usa timers para inventar evolução de tarefas.

O redutor puro `apps/web/operator/world/projector.mjs` normaliza a ordem das sequências, ignora versões de schema desconhecidas, registros cruzando projetos, duplicações e transições incompatíveis com a sequência já conhecida. Mesmo quando o replay diverge ou é parcial, **o status da tarefa do banco prevalece**, nunca o último evento presumido. Um hash ou prova de sequência visual só é atribuído quando o estado reproduzido coincide com o estado canônico.

O mapeamento da atividade de sprites é conservador:

| Status da tarefa | Estação | Representação |
| --- | --- | --- |
| `planning` | Arquiteto | movimento mínimo de sprite, apenas com SSE conectado e snapshot reconciliado |
| `implementing` | Desenvolvedor | idem |
| `testing` | QA | idem |
| `reviewing` | Revisor | idem |
| `awaiting_approval` | Revisor | marcador **aguardando decisão humana**, **sem** animação de trabalho |
| demais estados | nenhuma | sem trabalho em animação |

Quando uma estação possui várias tarefas, o painel mostra o total e destaca deterministicamente a tarefa atualizada mais recentemente (desempate por ID). O sistema não atribui progresso percentual ou duração de execução, pois a API não comprova essas métricas.

### Reconnect, segurança e acessibilidade

- A API SSE usa `fetch` com cabeçalho Authorization. Depois de desconexão, o painel altera o estado visual para **sem conexão**, encerra movimento e mantém os dados apenas como último snapshot conhecido.
- Ao reconectar, primeiro carrega novamente tarefas e páginas de eventos; durante a leitura mantém estado **sincronizando** sem movimento. Só anima com snapshot autoritativo após consulta concluída. Consultas pendentes não reativam animação se a conexão cair novamente.
- Reprodução do histórico é uma **reconciliação de estado**, não um filme fictício do passado. A interface mostra contagem de transições aceitas, última sequência verificada, completude e estado por papel em HTML acessível.
- A consulta é autenticada e isolada por projeto. O redutor rejeita registros de outros projetos; sem `localStorage`/ `sessionStorage`, token em URL, CDN, novo endpoint, escrita de arquivos ou automerge. S15 mantém decisão humana.
- Phaser instancia quatro personagens em S21, e na S22 só aplica `applyProjection`/tweens às estações comprovadamente em andamento. Em caso de pausa/desconexão, stop de tween e estado visual atenuado.

### Validação

- `tests/office-projection.test.ts`: 11 testes adversariais de status, isolamento, ordem/duplicação, replay contraditório, offline, budget do histórico e sem aprovação fictícia.
- `pnpm run smoke:projection`: 9 verificações sobre artefatos compilados e política de autorização; parte do `pnpm run check`.
- `node scripts/smoke-operator-browser.mjs`: browser Edge headless com projeto **sintético**, interrupção real de transporte SSE, pausa visível, alteração de estado no servidor fixture, reconexão, replay, papel ativo correto, revisão humana sem tween, e verificações S20/S21. Capturas sintéticas não exibem dados de projetos reais.
- Gates finais: privado com PostgreSQL/Ubuntu 233/233, zero skips, 15 smoke tests; clone independente com dependências congeladas; snapshot público sem segredos + Gitleaks e GitHub Actions SUCCESS no SHA exato.

**Limites conhecidos:** listas de tarefas da API têm teto de 500 e replay de eventos 3000; um histórico parcial é identificado sem inferir transições ausentes. A visualização não comprova execução de modelos em si, apenas status persistidos. Multiplos projetos locais sem token manual são critérios futuros S24-C02/S49-C02, não modificados aqui.
