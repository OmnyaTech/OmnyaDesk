# S26 — OmnyaDesk dentro do Visual Studio Code

O Extension Host guarda um token exclusivo de leitura no SecretStorage do VS Code. A interface Phaser utiliza somente dados sanitizados enviados via postMessage; não recebe token, credenciais do desktop, permissões para shell/filesystem nem URL controlada pelo Webview.

## Instalar
1. Execute pnpm install --frozen-lockfile e pnpm run vscode:build no repositório.
2. Na pasta apps/vscode execute pnpm dlx @vscode/vsce@3.6.2 package --no-dependencies --out omnyadesk-vscode-0.1.0.vsix.
3. Execute code --install-extension omnyadesk-vscode-0.1.0.vsix.
4. No VS Code use Ctrl+Shift+P e o comando OmnyaDesk: Configurar token de leitura. Depois OmnyaDesk: Abrir escritório.

A credencial é diferente da chave do aplicativo Tauri e deve ser criada com um token somente-leitura e expiração, via comando local de operador: pnpm token:issue UUID_PROJETO UUID_IDENTIDADE integration projects:read,tasks:read,events:read 24 vscode api (com DATABASE_URL configurada). Nunca compartilhe o token pelo chat ou inclua em commits. Revogar no VS Code usando OmnyaDesk: Remover credencial local e revogar no backend quando necessário.

## Contrato de segurança
- Webview envia apenas ready, refresh, selectProject UUID, inspectTask UUID; campos adicionais são rejeitados.
- O host faz GET para 127.0.0.1 na porta configurada, somente rotas de projetos/tarefas/eventos; segue autorização por projeto, sem redirecionamentos, com timeout de 6s e limite de resposta de 2MB.
- CSP com default-src none, connect-src none, script nonce forte e arquivos locais; nada de CDN ou eval.
- As tarefas e transições vêm de snapshots e eventos persistidos. A interface não cria tarefas nem aprova mudanças.
- Atualização a cada 8s enquanto o Webview está visível; informações podem ficar indisponíveis se API local for interrompida.

## QA
pnpm run vscode:test: 18 verificações de host/protocolo e 4 de navegador com canvas Phaser. O teste do VS Code real instala o VSIX em perfil separado (C:\OmnyaDeskS26VSCodeQA), ativa o comando na Paleta e confirma que o Webview somente-leitura abre. pnpm check inclui validações privadas, build e host. O pacote VSIX, o perfil de teste e credenciais não são versionados.
