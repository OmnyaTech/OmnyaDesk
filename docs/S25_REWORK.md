# S25-REWORK — Experiências de janela independentes

## Objetivo e histórico
A S25 original entregou primitivas Tauri de janela, bandeja e preferência de monitor, mas os modos visuais eram o dashboard completo reduzido, provocando conteúdo cortado e rolagem. A S25-REWORK corrige essa entrega antes de iniciar S27 sem substituir os critérios já aceitos de S24/S25/S26.

## Quatro composições
- **Completo**: painel operacional existente e OfficeWorld/Phaser com enquadramento de quatro estações, feed lateral de eventos persistidos, alertas de revisão humana, inspeção de tarefa e evidências S15/S23.
- **Compacto**: layout independente horizontal (980×250) com quatro agentes, estações pixel art, projeto, status de conectividade, contagem de execução e revisão. Nenhum dashboard em miniatura.
- **Flutuante**: layout dedicado (660×390), cena leve dos agentes, resumo real de tarefas e intervenções; clique em tarefa retorna ao modo completo para inspeção.
- **Taskbar**: faixa de janela normal do Windows (1000×135), com ícone, avatares, contagem de tarefas e botões de modo. É um estilo inspirado na taskbar, **não** extensão da barra de tarefas, não faz injeção no Explorer nem usa hooks globais.

### Contrato operacional
Fonte exclusiva: eventos e tarefas reais da API autenticada do projeto ativo. A função `projectOffice` aplica o estado persistido, jamais inventa execução. Perfis dos quatro agentes são papéis visuais canônicos, não novos agentes autônomos. Animações e alertas só refletem eventos verificados, sem autorizar aprovações. Se offline, status sinaliza API indisponível; quando não há atividade, agente aparece `Disponível`. Notificações no painel são eventos reais recebidos após uma linha-base inicial; notificações nativas do Windows permanecem futuras.

### Controles e configuração
Os quatro modos possuem troca sem sair do app e a janela nativa responde aos comandos Tauri permitidos. Compacto, Flutuante e Taskbar ocultam **inteiramente** a árvore do dashboard completo e renderizam uma experiência independente. O cabeçalho de login permanece acessível, inclusive se o modo salvo era compacto. O tray Tauri adiciona modo Compacto e mantém os controles de Sair/Abrir; Taskbar tem mínimo de 108 px nativos. O arquivo de geometria passa para `window-layout-v2.json` no mesmo diretório de configuração, evitando restaurar o tamanho legado cortado.

O script `scripts/install-desktop-local.ps1` copia o executável para `%LOCALAPPDATA%\Programs\OmnyaDesk\OmnyaDesk.exe`, valida SHA-256, recria atalhos e aguarda liberação de arquivo no Windows. Não migra nem altera credenciais Windows Credential Manager, tokens, bancos ou pastas de projeto.

## Critérios de aceite
1. Quatro layouts distintos visíveis e funcionais em WebView simulado, sem rolagem vertical ou dashboard cortado, incluindo projeto autorizado e estados reais dos agentes.
2. Rust 9/9, build native Tauri e controles reais Windows Compacto, Flutuante, Taskbar e Completo; posicionamento, sempre no topo, bandeja e restauração validados.
3. Screenshots de cada modo no Windows real e Playwright sintético; layout visual inspecionado. Não copiar imagens contendo projeto privado para o repo público.
4. Regressões S24 e S25, suite completa, clone independente frozen/offline, varredura de segredos e CI pública verde.
5. O executável atualizado deve estar instalado e funcionando pelo atalho principal; Nox registra os testes e volta a S27 PLANNED.

## Limites e próximas etapas
A referência visual de pixel art enviada pelo usuário define a direção de arte das S52–S59: salas detalhadas, conjunto expandido de avatares, pets, clima, decoração e cenas ricas ainda não foram implementados pela S25-REWORK. O produto nesta etapa usa sprites procedurais originais e quatro papéis operacionais verdadeiros. A cidade e OmnyaCoin continuam S76–S80 após S75. Nenhum conteúdo de trabalho ou pagamento é fictício ou simulado em produção.
