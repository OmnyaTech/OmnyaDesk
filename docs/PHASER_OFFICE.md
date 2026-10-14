# S21 — Mundo 2D Phaser e câmera navegável

## Objetivo e limite

A S21 acrescenta ao painel React autenticado um **escritório 2D Phaser 3** navegável. Ele tem um tileset 40×40 procedimental, quatro estações, quatro personagens originais em pixel art, câmera com limites, zoom e controles por teclado/mouse/toque via botões. Não executa modelos nem mostra atividade inventada. A ligação de eventos persistidos a animações fica **exclusivamente para S22**.

## Componentes

- `apps/web/operator/world/layout.mjs`: dimensões, IDs fixos e coordenadas das estações, zoom mínimo/máximo. `layout.d.mts`: tipos estáticos dos dados usados no teste TS.
- `OfficeWorld.jsx`: cena Phaser `OmnyaOffice`, tileset/textura `s21-floor-tiles` criada com Graphics, Tilemap com duas texturas de piso, sprites `s21-avatar-*` gerados em Graphics como atlas por papel (44×64) e estações com monitores, mesas e nomes.
- `world.css`: integração responsiva no painel React, controles com foco, texto alternativo para canvas e botões.
- `app.jsx`: mundo visível **somente após login**; entrada `#world` na navegação.
- `scripts/smoke-office-world.mjs`: smoke sobre o bundle servido pelo Fastify. `tests/office-world.test.ts`: invariantes dos papéis, estações, geometria, limites e ausência de conexão/auth falsa.
- `scripts/smoke-operator-browser.mjs`: smoke real de navegador headless com fixture sintético que confere pixels diferentes após focar outra estação, zoom, restauração, teclas, canvas e layout desktop/mobile.

## Navegação e acessibilidade

A cena aceita **setas/WASD** após foco no canvas, arraste para mover, scroll do mouse para alterar zoom e botões de direção, zoom, centralizar e quatro atalhos de estação. Os controles HTML são acessíveis por teclado e expõem rótulos. O canvas tem um texto descritivo; as estações estão listadas em botões acessíveis. O zoom é restringido a 65–165%, a câmera ao mapa de 1600×980; o canvas se adapta com `Phaser.Scale.FIT`. Se o navegador não oferecer canvas, a API e a seção de tarefas permanecem separadas.

**Originalidade/licença:** todos os gráficos do escritório foram desenhados em código para o OmnyaDesk, sem imagem, atlas ou asset baixado de terceiros. O piso e personagens são gerados localmente em runtime por `Phaser.Graphics.generateTexture`; Phaser 3 é uma dependência de terceiro sob licença **MIT**, com versão pinada no lockfile. Nenhum arquivo de fonte, imagens de terceiros ou dados de usuário integra os assets.

## Execução local

Após `pnpm install --frozen-lockfile` e `pnpm run build`, inicie a API PostgreSQL S07 no **Windows do operador**, com `DATABASE_URL` apenas na sessão de processo (não em arquivos públicos), via `node dist/apps/api/src/main.js`. Verifique `http://127.0.0.1:4317/v1/status` e `http://127.0.0.1:4317/operator`. O servidor só atende loopback; a página do operador é uma shell pública vazia de dados, e cada consulta precisa de Bearer válido. A interface mantém token apenas em memória de aba. O ambiente local de desenvolvimento possui inicializador privado em `.nox/evidence/S21/start-operator-local.ps1` para evitar o problema de `ERR_CONNECTION_REFUSED` quando o servidor ainda não foi iniciado. Ele não é publicado no GitHub.

## QA e gates

- Rodar `pnpm run check` com PostgreSQL e SSH privados S12/S13 obrigatórios: zero skips e 14 smoke tests compilados. As suítes de testes são serializadas entre arquivos com `--test-concurrency=1` para impedir interferência entre fixtures remotas simultâneas de S12/S13 no mesmo host Docker. Isso não relaxa nenhuma proteção; cada teste continua com o mesmo isolamento.
- Rodar `node scripts/smoke-operator-browser.mjs` em Edge/Chromium headless com fixture sintético, sem tokens/segredos reais: relatório S20 14/14 e S21 10/10, capturas em `dist/apps/web/operator/s21-office-*.png`.
- Repetir o `check` no commit privado fixo em clone independente com dependências congeladas e zero skips.
- Sanitizar 100% do snapshot público, Gitleaks de origem/histórico e GitHub Actions `SUCCESS` no SHA exato antes do `COMPLETED`.

A S21 **não** inclui mapeamento de estados para animações, reconstrução após desconexão, clique para abrir tarefas nem notificações; são S22 e S23. Mantenha OmnyaLog, IPv6, Docker daemon, redes e containers produtivos intocados.
