#!/usr/bin/env bash
set -euo pipefail
root="$HOME/.local/share/omnyadesk/s30"
export OMNYADESK_SECRET_FILE="$root/secrets/db_password"
compose(){ docker compose --env-file "$root/config/networks.env" -p omnyadesk -f "$root/release/infra/s30/compose.yaml" "$@"; }
await_healthy(){
 local name="$1" id state
 id="$(compose ps -q "$name")"
 [ -n "$id" ] || { echo "No S30 container for $name" >&2; return 1; }
 for n in $(seq 1 36); do
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
  [ "$state" = healthy ] && return 0
  [ "$state" = unhealthy ] && { echo "S30 unhealthy $name" >&2; return 1; }
  sleep 3
 done
 echo "S30 readiness timeout $name" >&2; return 1
}
check_http(){
 [ "$(curl --max-time 5 -sS -o /dev/null -w '%{http_code}' "$1")" = "$2" ]
}
compose config --quiet
echo 'S30_COMPOSE_CONFIG=PASS'
for part in db api worker web; do await_healthy "$part"; done
echo 'S30_FOUR_HEALTHY=PASS'
check_http http://127.0.0.1:4387/healthz 200
check_http http://127.0.0.1:4387/operator/ 200
check_http http://127.0.0.1:4387/v1/status 200
check_http http://127.0.0.1:4387/v1/projects 401
echo 'S30_WEB_AUTH_SMOKE=PASS'
web="$(compose ps -q web)"
api="$(compose ps -q api)"
db="$(compose ps -q db)"
worker="$(compose ps -q worker)"
[ "$(docker port "$web" 8080/tcp)" = '127.0.0.1:4387' ]
for id in "$api" "$db" "$worker"; do [ -z "$(docker port "$id")" ]; done
for part in "$web" "$api" "$db" "$worker"; do
  docker inspect "$part" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' |
  grep -Eq '^omnyadesk_(ingress|backend)$'
done
[ "$(docker network inspect omnyadesk_backend --format '{{.Internal}}')" = true ]
echo 'S30_LOOPBACK_PRIVATE_NETWORKS=PASS'
# Do not store credentials in compose configuration or Docker inspect environment.
if docker inspect "$api" --format '{{range .Config.Env}}{{println .}}{{end}}' |
 grep -Eq '^DATABASE_URL='; then echo 'Database URL leaked into image metadata' >&2; exit 1; fi
echo 'S30_SECRET_NOT_IN_INSPECT=PASS'
# Backup is created only for the named OmnyaDesk database.
umask 077
backup="$root/backups/s30-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec "$db" pg_dump -U omnyadesk -d omnyadesk -Fc > "$backup"
[ -s "$backup" ]
chmod 600 "$backup"
sha256sum "$backup" > "$backup.sha256"
(cd "$(dirname "$backup")"; sha256sum -c "$(basename "$backup").sha256") >/dev/null
echo 'S30_BACKUP_HASH=PASS'
# Restore into a temporary, newly created database; production is never overwritten.
testdb="omnyadesk_restore_s30"
docker exec "$db" createdb -U omnyadesk "$testdb"
cleanup(){ docker exec "$db" dropdb -U omnyadesk --if-exists "$testdb" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cat "$backup" | docker exec -i "$db" pg_restore -U omnyadesk -d "$testdb" --no-owner --no-privileges
original="$(docker exec "$db" psql -U omnyadesk -d omnyadesk -Atqc 'select count(*) from schema_migrations')"
restored="$(docker exec "$db" psql -U omnyadesk -d "$testdb" -Atqc 'select count(*) from schema_migrations')"
[ "$original" -gt 0 ] && [ "$original" = "$restored" ]
cleanup
trap - EXIT
echo 'S30_BACKUP_RESTORE_ISOLATED_DB=PASS'
compose restart api worker web >/dev/null
for part in api worker web; do await_healthy "$part"; done
check_http http://127.0.0.1:4387/v1/status 200
echo 'S30_RESTART_PERSISTENCE=PASS'
# Reversible service interruption and recovery, confined to OmnyaDesk.
compose stop web >/dev/null
[ "$(curl --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4387/healthz || true)" != 200 ]
compose start web >/dev/null
await_healthy web
check_http http://127.0.0.1:4387/healthz 200
echo 'S30_SERVICE_ROLLBACK_REHEARSAL=PASS'
for part in db api worker web; do await_healthy "$part"; done
echo 'S30_GATE_ALL=PASS'
