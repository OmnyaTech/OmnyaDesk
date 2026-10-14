# S27 — Arquivos e mídia: anexo privado, prévia de diff e evidência

## Produto
Na tela **Tarefas do projeto**, selecione uma tarefa. Em **Detalhes**, o painel **Arquivos e mídia** permite escolher, enviar, listar, pré-visualizar e salvar anexos vinculados exclusivamente à tarefa selecionada, incluindo diffs de código. A subseção anterior de **Evidências verificadas** continua exibindo hashes/resumos do ledger imutável; anexos privados são documentos complementares, **não substituem o ledger S15** nem atestam uma aprovação. O painel nunca executa scripts, HTML ou PDF.

O modo completo do desktop é o local de inspeção. Os modos Compacto/Flutuante/Taskbar permanecem como implementados na S25-REWORK, sem editor ou uploader comprimido.

## Regras e autorização
- MIME estritamente permitido: `image/png` (.png), `image/jpeg` (.jpg/.jpeg), `application/pdf` (.pdf), `text/plain` (.txt) e `text/x-diff` (.diff/.patch). Tudo mais é negado.
- Limite **1 MiB por arquivo**, **20 arquivos por tarefa** e **32 MiB por projeto**. O servidor confere extensão + assinatura/magic + base64 canônico + UTF-8 texto sem controles; PDF é tratado como arquivo passivo e recusado se contiver marcadores de JavaScript/launch/XFA conhecidos. Isso **não substitui antivírus** nem garante segurança de leitores externos; arquivos suspeitos jamais devem ser abertos fora de ambientes confiáveis.
- Nada é gravado na raiz do projeto, repositório Git ou diretório `/operator`. Binários são `bytea` no PostgreSQL privado (`017_private_task_attachments.sql`), vinculados por FK composta a `(project_id,task_id)` e imutáveis após inserção. O SHA-256 é verificado ao ler; metadados retornam isoladamente dos bytes. Quota é serializada por lock transacional no projeto para evitar race.
- API browser: GET list/download exige `tasks:read`; POST exige nova permissão independente **`files:write`**, explicitamente emitida para o projeto/identidade. Tokens existentes permanecem somente leitura. A permissão foi adicionada à whitelist de migrations por `018_attachment_scope.sql`.
- API desktop: POST exclusivamente por `desktop_upload` host Tauri após seleção autenticada; usa a credencial de estação no Gerenciador de Credenciais do Windows, com validação do projeto selecionado, UUIDs e caminho fixo. Backend impõe autenticação de estação, ACL do projeto, loopback e Origin/Fetch-Metadata ausentes. A credencial/token jamais é transmitida ao WebView2. `desktop_read` permite apenas paths de leitura de anexos, não shell ou arquivos arbitrários.
- Respostas de bytes são JSON Base64 `no-store` após autorização específica; visualização é texto escapado pelo React ou `img` data URI para imagens. PDF não é renderizado; apenas metadados e link de salvar, evitando PDF/script em WebView2. Não há execução, upload de ZIP/EXE, iframe ou HTML arbitrário.
- Os arquivos não são expostos publicamente nem incluídos em commits/artefatos VSIX. O backup do banco precisa abranger `task_attachments`; restore deve preservar dados+hash.

## API
```text
GET  /v1/projects/:projectId/tasks/:taskId/attachments
GET  /v1/projects/:projectId/tasks/:taskId/attachments/:attachmentId
POST /v1/projects/:projectId/tasks/:taskId/attachments
POST /v1/workstation/projects/:projectId/tasks/:taskId/attachments [somente host nativo]
```
POST usa JSON estrito `{"filename":"changes.diff","mimeType":"text/x-diff","dataBase64":"..."}`. Em produção não mostre `dataBase64` em logs ou UI fora da prévia explícita. Arquivos são append-only, sem delete/overwrite pelo usuário.

## Quality gates
- `node --experimental-strip-types --test tests/attachments.test.ts`: MIME/magic, negação de executável/PDF ativo, auth/ACL, SHA-256, imutabilidade, cross-tenant, token readonly, quota concorrente e OpenAPI.
- `node scripts/build-desktop.mjs && node scripts/smoke-desktop-webview.mjs`: upload nativo sintético, lista e diff escapado, sem tráfego direto do WebView2 para a API e sem token no renderer, mais regressão S24/S25.
- Rust `cargo test --locked` no staging Windows: allowlist de caminhos GET de anexo, geometria, cofre.
- `pnpm check`, build Tauri e smoke com app instalado, clone independente com lockfile offline/migrations e CI pública.
- Evidências somente em `.nox/evidence/S27`, sem bytes nem credenciais versionados.

## Limites conhecidos
Uma imagem/JPEG ou um PDF formalmente válido ainda pode explorar bugs de leitores externos; não existe scanner antivírus dedicado nesta sprint. Por isso tamanho/formatos são estritos, PDF não tem execução ou prévia inline, e não se permitem conteúdos ativos, executáveis ou arquivos compactados. Diferenciação visual e animações de agentes permanecem sprints S52–S59. Nenhum mecanismo de aprovação ou alteração do ledger foi incluído.
