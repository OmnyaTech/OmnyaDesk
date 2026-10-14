# S24 — OmnyaDesk Desktop (Windows / Tauri 2)

## Separação de responsabilidades
O aplicativo compartilha exatamente a mesma interface React/Phaser do operador Web; o shell Tauri faz somente a ponte do seletor de pastas, do cofre nativo de credenciais e das requisições à API local. Estado de tarefas e eventos provêm exclusivamente do PostgreSQL/API, sem simulação de progresso. A atualização desktop usa polling de eventos autenticado a cada 1,8 s, não um falso SSE; quando a API cai, o cliente marca offline e interrompe animações. O streaming SSE Web continua como antes.

## Preparação
- Windows 10/11, WebView2 e runtime MSVC/Rust estáveis, Node 22+, pnpm 10+.
- Banco PostgreSQL privado com migrations versionadas: `pnpm db:migrate`.
- API OmnyaDesk disponível somente em `http://127.0.0.1:4317` (nunca publicar diretamente na rede).
- Configure **no processo da API**, antes de iniciar, `OMNYA_WORKSTATION_ALLOWED_ROOTS` como lista absoluta separada por `;` de raízes autorizadas no Windows, por exemplo `D:\Projects;E:\AuthorizedWorkspaces`. A omissão significa **deny all**, inclusive para administrador.
- Crie uma identidade de operador existente e emita **uma única chave de inscrição da estação** pela CLI: `node --experimental-strip-types apps/cli/src/issue-workstation.ts <subject-uuid>` com `DATABASE_URL` configurado. A CLI imprime a chave uma vez no console privado; nunca cole-a em log, documento, commit ou chat. A chave expira em até 30 dias. Para rotacionar, revogue sua linha em `workstation_sessions` via procedimento administrativo auditado.
- No primeiro uso, cole a chave **uma única vez** na tela do OmnyaDesk Desktop. O Windows Credential Manager a guarda por usuário. Não é preciso emitir nem colar tokens por projeto.

## Seleção de pastas e isolamento
Clique em **Adicionar pasta** para abrir o seletor de pastas nativo do Windows. O caminho escolhido é enviado exclusivamente ao backend local, com autenticação da estação. O backend valida caminhos absolutos, realpath, raiz autorizada e componentes sem symlink/junction, depois cria um registro do projeto e ACL na mesma transação. A UI lista apenas projetos vinculados àquela estação e alterna a sessão sem exibir bearer de projeto. O token temporário de leitura fica somente no processo Rust, renovado pela ACL da estação e nunca entregue ao WebView. O registro de projeto não concede permissão de escrita, ferramenta, integração Git nem aprovação.

O endpoint `/v1/workstation/*` exige Bearer de estação, origem loopback, Host local e **ausência** de Origin/Referer/Sec-Fetch-Site; requisições de páginas da Web são negadas. A ponte Tauri oferece somente `desktop_restore`, `desktop_login`, `desktop_register`, `desktop_select`, `desktop_read`, `desktop_poll` e `desktop_logout`. A allowlist Rust limita `desktop_read` a projetos/tarefas/eventos/evidências do projeto ativo; não há permissão Tauri para shell, filesystem arbitrário, opener ou HTTP do renderer. S10/S13/S15 permanecem exclusivamente no backend.

## Compilar e executar
`node scripts/build-desktop.mjs` compila frontend compartilhado em `dist/apps/desktop`. O app nativo usa `apps/desktop/src-tauri/Cargo.toml` / `tauri.conf.json`; execute `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` e `pnpm desktop:build` para gerar o executável em `dist/apps/desktop-bin/omnyadesk-desktop.exe` com staging seguro automático. O pacote NSIS requer ferramentas de empacotamento Tauri, executadas num diretório local sem caracteres incompatíveis com rc.exe (um caminho do projeto contendo apóstrofo pode impedir a compilação de recursos do Windows). Um estágio descartável **fora do Git** com código e ativos equivalentes serve para validar o executável sem alterar o caminho original.

## Limites e proteção
- A interface é somente leitura: aprovações e execução de ferramentas exigem controles S15/S10/S13. Nenhuma chave privada ou bearer aparece no JavaScript.
- Nenhum progresso animado durante queda ou recuperação incompleta da API local.
- O seletor registra pastas existentes, mas não concede automaticamente acesso ao conteúdo à ferramenta Codex. Permissões para execução são processos separados e verificáveis.
- Um login único significa inscrição **por estação** com reautorização após expiração; não significa bypass do controle por projeto. Não cole tokens por projeto.
- Não exponha a API local em hosts públicos e não desative filtros de Host, Origin ou caminho.
