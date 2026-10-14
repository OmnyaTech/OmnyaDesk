# S25 — Modos da janela Windows (Tauri 2)

O aplicativo OmnyaDesk dispõe de três modos **nativos**, sem substituir ou modificar a barra de tarefas do Windows: **Completo** (1320×860), **Flutuante** (720×570) e **Faixa compacta** (1000×230). A faixa é uma janela comum do Windows com o canvas Phaser original compartilhado, não uma extensão da taskbar do sistema. Pode ser movida e redimensionada com o comportamento normal do Windows. O botão **Sempre no topo** é opcional e permanece desligado por padrão.

A interface exibe controles somente no aplicativo Tauri; no navegador o operador original permanece inalterado. Também é possível restaurar a janela e mudar de modo pelo ícone na bandeja. Fechar a janela principal a oculta na bandeja; sair de verdade requer **Sair do OmnyaDesk** no menu, evitando perda silenciosa do monitoramento. O processo não captura o teclado ou mouse globalmente, não recebe permissões de shell, filesystem, navegador externo nem novas permissões de API.

As opções e a geometria são salvas no diretório de configuração do aplicativo, em `window-layout-v1.json` (sem credenciais), por monitor identificado pelo nome e coordenadas físicas. A restauração só tenta usar o monitor que ainda estiver conectado; em desconexões ou mudança de escala, tamanhos e coordenadas são limitados à área física visível. Para persistir movimentos/resize, as atualizações são limitadas a uma gravação a cada 650 ms, com sincronização forçada ao fechar. As credenciais permanecem exclusivamente no Windows Credential Manager (S24).

**Performance:** o Phaser renderiza a 24 FPS em vez de 60 e pausa sua cena quando o WebView está oculto. Os eventos reais de tarefas continuam carregados pela API; não é simulada atividade enquanto a janela está escondida ou desconectada. O desenho é retomado após restaurar a janela.

**Limitações:** aplicativos em *fullscreen exclusivo*, jogos que ocupam o topo ou software anti-cheat podem ocultar a janela flutuante apesar de `always-on-top`. Não é um overlay capturado pelo DirectX nem fornece click-through. A tela não modifica a taskbar real. Para reduzir interferência, a faixa tem bordas e controles normais, não usa ganchos de mouse/teclado, e o uso de dois monitores precisa ser validado em Windows com ambos conectados antes do aceite físico. O modo compacto foca a representação do escritório; tarefas completas continuam acessíveis ao voltar ao modo completo.

Os testes incluem parser de modos nativos, geometria de monitor secundário com coordenadas negativas, recuperação de dimensões fora da tela, proteção de arquivo de preferência, ponte WebView (seleção dos três modos, foco e bandeja), testes de integração e verificação Windows do executável compilado.

## Estratégia de QA quando há somente um monitor

O hardware de referência possui apenas uma tela conectada; **não é exigida a compra de um segundo monitor**. A S25 é avaliada por uma combinação de testes de janela Windows real em um monitor e testes determinísticos de topologia virtual na própria implementação Rust. A bateria `cargo test --locked` cobre (1) desktop virtual com coordenadas negativas, (2) segunda tela à esquerda/direita, (3) diferenças de resolução/DPI, (4) desconexão do segundo monitor com retorno centralizado na tela principal e (5) preservação do modo e da opção sempre-no-topo. O código de startup seleciona o monitor salvo somente se ainda existir; caso contrário reposiciona a janela no monitor principal.

A validação física em dois monitores **permanece não executada**, registrada como ressalva de QA para um ambiente com hardware futuro. Ela não deve bloquear as entregas utilizáveis no hardware disponível nem pode ser descrita como teste real executado. Manter um teste adicional de compatibilidade de dois monitores no backlog de regressão quando essa infraestrutura estiver disponível.

## Distribuição local da versão correta (pós-S25)

A compilação do projeto **não atualiza automaticamente** uma janela Tauri aberta de sprints anteriores. Após gerar o binário Windows com pnpm run desktop:build, instale a versão reconstruída usando: powershell -ExecutionPolicy Bypass -File scripts/install-desktop-local.ps1 -SourceExe dist/apps/desktop-bin/omnyadesk-desktop.exe -Launch.

Esse instalador copia o EXE para %LOCALAPPDATA%/Programs/OmnyaDesk/OmnyaDesk.exe, verifica SHA-256 e atualiza os atalhos OmnyaDesk da Área de Trabalho e do menu Iniciar. Não modifica o cofre de credenciais, sessões, PostgreSQL nem arquivos dos projetos. A instalação não ocorre automaticamente apenas por aprovar uma sprint. A janela de QA anterior em C:/OmnyaDeskS24QA não deve ser utilizada como atalho final.
