# M0.1 — Definição do MVP Hybrid

## Objetivo e público

Um único operador cria solicitações sobre um repositório **de teste**, vê 4 agentes com papéis especializados numa planta pixelada, acompanha evidências reais de execução e decide aprovar/rejeitar uma entrega.

## Dentro do MVP de produção

1. Criação/seleção de projeto e associação a um repositório Git de teste.
2. Quatro papéis (arquiteto, desenvolvedor, QA, revisor), com competências configuradas; a implementação inicial pode ser sequencial, sem quatro LLMs rodando ao mesmo tempo.
3. Adaptador mock **e um provedor real** (Codex), com registro de modelo/uso/custo estimado.
4. Orquestração com estados, 1 pipeline, retries limitados, cancelamento e aprovação humana.
5. Worktree por execução, isolamento real do processo, comparação de diff e testes executados sem privilégios excessivos.
6. Registro persistente de eventos, tarefas, decisões, logs e artefatos.
7. API local e CLI, interface React/Phaser e uma extensão VS Code para painel visual e acompanhamento.
8. Painel de governança: status, atividades, custo, erros, evidências, aprovar/rejeitar.
9. MCP local de consulta e criação de tarefas; exposição remota autenticada entra após auditoria de segurança.

## Fora do MVP

- Moeda, salários, loja, pets e cosméticos.
- Reuniões entre agentes, discussões multi-LLM simultâneas e otimização automática global de provedores.
- Templates de contabilidade, multiempresa/multitenant SaaS, integrações com ERP.
- Aplicativo móvel, marketplace de skills e marketplace comercial.
- Auto-merge/push/deploy sem autorização humana.

## Critérios de aceite verificáveis

- [ ] Uma tarefa criada no VS Code aparece no backend, no CLI e no mundo visual.
- [ ] No reinício do servidor, tarefas/eventos/decisões continuam íntegros.
- [ ] Um agente real executa no sandbox e registra passos, logs, artefatos e diff.
- [ ] A interface visual exibe estados a partir de eventos (não de timers locais).
- [ ] QA executa testes reais e apresenta resultado verificável.
- [ ] Uma entrega só é concluída como aprovada após decisão humana válida.
- [ ] Operação destrutiva/fora do workspace é bloqueada e registrada.
- [ ] Falha de rede/LLM não resulta em aprovação falsa; retry é limitado.
- [ ] Limites de custo/passos/tempo impedem execução sem controle.
- [ ] Um teste end-to-end valida tarefa → execução → diff → aprovação.

## Critério de saída (Go / No-Go)

Só chamar de MVP funcional quando os itens acima estiverem comprovados num repositório descartável, com logs e testes. O pacote atual valida exclusivamente o fluxo visual **simulado**.
