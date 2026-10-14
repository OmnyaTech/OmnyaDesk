# OmnyaDesk — Extensão VS Code (S26)

Extensão de visualização **somente leitura** do escritório Phaser compartilhado com OmnyaDesk. Os dados são obtidos pela API local do OmnyaDesk pelo **Extension Host**; o Webview não possui rede, token, permissões de filesystem, execução de comandos nem acesso às credenciais.

## Uso

1. Inicie a API OmnyaDesk em `127.0.0.1:4317` (configurável por `omnyadesk.apiPort`, sempre loopback).
2. No VS Code, execute `OmnyaDesk: Configurar token de leitura`; informe token de projeto somente leitura emitido pelo CLI (S10).
3. Execute `OmnyaDesk: Abrir escritório`. A seleção de projetos é limitada aos projetos retornados pela API autenticada.
4. Execute `OmnyaDesk: Remover credencial local` para remover a credencial do **SecretStorage**.

O escritório é atualizado a cada 8s enquanto visível; tarefas são renderizadas a partir de dados persistidos do projeto autorizado. Eventos são verificados pelo redutor canônico do S22, sem simulação de execução. Nenhuma aprovação humana pode ser feita por esta extensão.

## Segurança e QA

CSP sem `unsafe-inline`, `unsafe-eval` ou `connect-src`; JS e CSS carregados somente de `localResourceRoots`, JS com nonce de 160 bits. O Webview envia apenas pedidos enumerados e validados. O Extension Host faz `GET` com `Authorization` Bearer para endpoints em `http://127.0.0.1:<port>/v1/projects…`, com timeout, sem redirects nem leitura de URL arbitrária; valida projeto/tarefa e remove dados externos não permitidos. Nenhuma credencial é enviada ao Webview. O token fica em `context.secrets`.

Build: `pnpm run vscode:build`. Testes: `pnpm run vscode:test`. A publicação de pacote usa `vsce package --no-dependencies` com dependências de desenvolvimento excluídas. Para uso no editor: `code --install-extension apps/vscode/omnyadesk-vscode-0.1.0.vsix` (após empacotar). Dependências nativas não são adicionadas.
