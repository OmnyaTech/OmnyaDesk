# S20 — Painel operacional React (API-first)

A S20 substitui, em modo PostgreSQL, o protótipo visual sem autenticação por um **painel operacional React**. A interface acompanha o estado real de um único projeto autorizado e não inicia agentes, altera arquivos, executa merges ou aprova tarefas.

## Como executar localmente

1. Configure `DATABASE_URL` de um PostgreSQL isolado e execute `pnpm run build`.
2. Inicie `pnpm start`. O Fastify persistente fica restrito a `127.0.0.1:4317` por padrão; não exponha a rede.
3. Acesse **http://127.0.0.1:4317/operator**.
4. Gere um token humano/integrador **específico do projeto**, com os escopos `projects:read`, `tasks:read` e `events:read` pelos fluxos S07/S09 existentes; não coloque a credencial em URLs ou arquivos. Digite-o somente no formulário de acesso. O navegador mantém o token na memória React enquanto a aba estiver aberta; após atualização ou logout, precisa ser digitado de novo.

O antigo `/` em modo **sem banco** continua sendo apenas a demonstração S02, com APIs de mock localhost. No modo com PostgreSQL, o operador deve sempre acessar `/operator` e a API autenticada `/v1`.

## Interface entregue

- Cabeçalho de conexão, status de SSE autenticado, atualização manual, logout e projeto vinculado ao token.
- Indicadores de tarefas totais, etapas em andamento, tarefas aguardando revisão humana e aprovadas **conforme status persistido**, nunca inferido da atividade visual.
- Lista compacta e filtrável de tarefas (limite servidor: 500); clique na linha abre detalhes na coluna lateral, com ID, versão, execução, estado e descrição.
- Linha do tempo dos eventos de tarefa (eventos persistidos da API), data, tipo e ator.
- Resumos das evidências S14, com tipo, versão, timestamp, hash de conteúdo e hash encadeado. Sem mostrar o conteúdo original, metadata arbitrária ou o texto das respostas dos agentes.
- Layout desktop/mobile, rótulos acessíveis, estados vazios e de erro, e comportamento responsivo.

O cliente usa exclusivamente `/v1/projects`, `/v1/projects/:id/tasks`, `/v1/projects/:id/events`, `/v1/projects/:id/tasks/:taskId/evidence` e `/v1/projects/:id/stream`. A conexão SSE usa **fetch com Authorization Bearer**, `Last-Event-ID` e reconexão controlada; `EventSource` tradicional não é utilizado, pois não enviaria o cabeçalho Authorization. Atualizações reais provocam nova consulta ao banco. O cliente jamais armazena tokens em localStorage, sessionStorage ou query string.

## Segurança

- Servidor Fastify S07 somente loopback; `/operator` e assets estáticos não contêm dados de tenants, segredos ou tokens. Cada requisição de dados é novamente autenticada e autorizada.
- As novas evidências são indexadas com `tasks:read`, escopo do projeto/tenant no middleware global, checagem explícita de propriedade da tarefa e verificação SHA-256 por cadeia selecionada. Limite: últimas 100 entradas, **somente metadados autorizados** do índice, sem conteúdo bruto ou metadata arbitrária.
- CSP rigorosa: scripts, estilos e conexão somente do próprio domínio; sem `unsafe-inline`, iframe ou CDN. Cabeçalhos `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `nosniff`.
- Nenhum botão de aprovação/merge no painel, pois decisões humanas requerem o fluxo transacional com hash S15. Não há CORS liberal ou novas APIs públicas de escrita.
- Não implante a interface em host público sem as etapas posteriores de TLS, segurança de borda e autenticação operacional. Token Bearer permanece acessível em memória JS durante a sessão, portanto a proteção do navegador e CSP são essenciais.

## QA e reprodução

- `tests/operator-panel.test.ts` verifica respostas com token válido, expiração/escopo, isolamento entre projetos, tarefa inexistente, SQL injection e ausência de payload secreto em evidências.
- `pnpm run smoke:operator` testa **artefatos compilados**, CSP, bundles locais, rotas e segurança S07; é parte de `pnpm check`.
- `node scripts/smoke-operator-browser.mjs` roda cenário sintético headless em Edge/Chromium, sem dados ou tokens reais: login/negação, busca, detalhes, SHA, eventos SSE, logout, viewport 390px, armazenamento volátil. Exige `playwright-core` e navegador local; fica fora da CI pública (que não garante navegador instalado). Capturas geradas em `dist/apps/web/operator/` são apenas do fixture sintético.
- Testes privados com PostgreSQL/S12/S13 devem rodar com **zero skips**, clone independente com lockfile congelado, depois auditoria pública Gitleaks/CI. A publicação pública deve conter somente código replicável e nenhum arquivo de credencial.

**Limites:** o operador inspeciona estados e evidências presentes, não reconstrói etapas ausentes nem substitui a aprovação humana. Renderização Phaser e animação são tarefas posteriores da S21/S22.
