# S30 — Stack Docker exclusiva do OmnyaDesk

A configuração de referência é `infra/s30/compose.yaml` com o projeto Compose **omnyadesk**. Não reaproveita PostgreSQL, volumes, redes, credenciais ou containers de OmnyaFinance, OmnyaLog ou S.P.I.D.E.R. O acesso é **somente `127.0.0.1:4387`**, reservado ao web; Cloudflare Tunnel e Access permanecem na S31.

## Inventário e implantação

Antes de implantar, registrar o baseline de todos os containers em execução (ID, nome, estado, health e portas), redes/volumes, listeners e túneis. Confirmar 4387 livre e ausência de projeto `omnyadesk`. Não executar `docker system prune`, `docker compose down --volumes`, `docker network prune` ou qualquer operação que alcance outros projetos.

No servidor Ubuntu, usar um diretório de operação privado e próprio:

```sh
# Execute o provisionamento após criar uma release Git limpa em:
# ~/.local/share/omnyadesk/s30/release
bash ~/.local/share/omnyadesk/s30/release/scripts/s30-provision.sh
# Preencha manualmente dois CIDRs privados /27 livres, distintos e sem conflitos com o host:
# OMNYADESK_INGRESS_SUBNET=<CIDR_PREVIAMENTE_VALIDADO>
# OMNYADESK_BACKEND_SUBNET=<OUTRO_CIDR_PREVIAMENTE_VALIDADO>
${EDITOR:-vi} ~/.local/share/omnyadesk/s30/config/networks.env
chmod 600 ~/.local/share/omnyadesk/s30/config/networks.env
export OMNYADESK_SECRET_FILE="$HOME/.local/share/omnyadesk/s30/secrets/db_password"
cd ~/.local/share/omnyadesk/s30/release
docker compose --env-file "$HOME/.local/share/omnyadesk/s30/config/networks.env" -p omnyadesk -f infra/s30/compose.yaml config --quiet
docker compose --env-file "$HOME/.local/share/omnyadesk/s30/config/networks.env" -p omnyadesk -f infra/s30/compose.yaml build api web
docker compose --env-file "$HOME/.local/share/omnyadesk/s30/config/networks.env" -p omnyadesk -f infra/s30/compose.yaml up -d --no-build
bash scripts/s30-qa.sh
```

O provisionamento gera segredo aleatório hexadecimal (32 bytes) com permissão `0600` fora de código, artefatos ou Git. O Compose monta como Docker secret. API/worker constroem a string de conexão **dentro do processo**, após inicialização. O arquivo `.env` versionado não contém credenciais. Nunca imprimir `docker compose config` com segredos (use `--quiet`) nem salvar `docker inspect` com variáveis não filtradas.

## Arquitetura e políticas

| Serviço | Imagem | Rede | Recursos | Health |
|---|---|---|---|---|
| web | Nginx 1.28 Alpine fixado por digest | `omnyadesk_ingress`, porta `127.0.0.1:4387:8080` | 128 MiB, 0.30 CPU, 64 PIDs | HTTP `/healthz` |
| api | Node 22 bookworm-slim fixado por digest | ingress + `omnyadesk_backend`; sem publicação de porta | 640 MiB, 0.70 CPU, 128 PIDs | GET `/v1/status` |
| worker | Mesmo aplicativo Node | backend interna somente | 512 MiB, 0.50 CPU, 80 PIDs | socket TCP privado do banco |
| db | PostgreSQL 17 Alpine fixado por digest | backend interna; volume `omnyadesk_db_data` | 768 MiB, 0.65 CPU, 128 PIDs | `pg_isready` |

As redes recebem dois CIDRs privados `/27` definidos exclusivamente em `~/.local/share/omnyadesk/s30/config/networks.env`, escolhidos após verificar as rotas e todos os blocos Docker; não dependem dos pools automáticos, já esgotados no servidor. A rede `backend` tem `internal: true`. API, worker e web rodam com filesystem principal somente leitura, tmpfs mínimo, `no-new-privileges`, redução de capabilities e sem Docker socket. O PostgreSQL possui escrita apenas no volume nomeado e startup controlado; seu arquivo de segredo é montado pelo Compose.

A API rejeita `0.0.0.0` por padrão e libera bind somente quando `OMNYA_DOCKER_PRIVATE=1` **e** o processo detecta `/.dockerenv`. A publicação de host continua exclusivamente no web (loopback). A API não está pronta para publicação WAN isolada e não deve receber mapeamento direto.

**Limite funcional:** o worker desta fase executa `simulatedWork`, não Codex ao vivo. API e UI usam o banco PostgreSQL exclusivo. A migração `001..` é aplicada somente a esta base.

## Backups, restore e recuperação

```sh
# Backup autenticado local por socket, no próprio banco OmnyaDesk:
bash ~/.local/share/omnyadesk/s30/release/scripts/s30-backup.sh
# Exercita backup, checksum e restore em banco TEMPORÁRIO, nunca sobre dados originais:
bash ~/.local/share/omnyadesk/s30/release/scripts/s30-qa.sh
```

Os dumps customizados `pg_dump -Fc`, hashes SHA-256 e backups são gravados com permissão 0600 sob `~/.local/share/omnyadesk/s30/backups`. O teste restaura em `omnyadesk_restore_s30`, compara `schema_migrations` e apaga **apenas** esse banco temporário. Antes de atualizações, gerar novo dump verificado e copiar artefatos para armazenamento externo criptografado sob política do operador. Uma rotina diária de backup/retenção e teste periódico de restore devem ser agendados na operação; esta sprint configura scripts e executa restore, **não** instala automaticamente um cron fora do escopo.

Para rollback de uma futura atualização, manter a release anterior imutável e imagens anteriores por digest, parar **somente** `web/api/worker` do projeto omnyadesk e aplicar `up -d --no-build` sobre o Compose anterior, sem remover `db_data`. Se uma migração alterou formato de banco sem backward compatibility, requer backup pré-upgrade validado e janela de manutenção específica; `docker compose down -v` é proibido. O smoke S30 faz uma recuperação controlada da instância web e restart dos componentes, sem alterar outras stacks; a reversão entre duas versões não é reivindicada na implantação inaugural.

## Gate de aceite S30-C01

- Configuração `docker compose -p omnyadesk config --quiet` PASS com secrets externos e imagens por digest.
- Quatro serviços em estado healthy, UI local e API protegida (401 sem token), nenhum listener extra ou porta em WAN.
- QA reinício e interrupção/reversão do web PASS; backup de DB e restore em banco isolado PASS.
- Comparação antes/depois dos IDs, rotas e estados dos containers preexistentes, especialmente `spider-production` e `omnyafinance-c09`, sem interferência atribuível à S30.
- Testes unitários, regressões, auditoria do repo público, CI e revisão de riscos PASS.
- Evidência em `.nox/evidence/S30/` (inventários, imagens, build, QA, comparação, revisão de segurança).

S31 (Cloudflare) **não** pode utilizar hostname público sem Access configurado e origin autenticado. O fato de `4387` funcionar por loopback não significa serviço aberto à internet.
