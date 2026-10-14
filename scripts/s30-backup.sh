#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$HOME/.local/share/omnyadesk/s30"
backupdir="$root/backups"
mkdir -p "$backupdir"
export OMNYADESK_SECRET_FILE="$root/secrets/db_password"
compose(){ docker compose --env-file "$root/config/networks.env" -p omnyadesk -f "$root/release/infra/s30/compose.yaml" "$@"; }
id="$(compose ps -q db)"
[ -n "$id" ] || { echo 'S30 DB not running' >&2; exit 1; }
dest="$backupdir/omnyadesk-$(date -u +%Y%m%dT%H%M%SZ).dump"
if [ -e "$dest" ]; then echo 'Backup filename collision' >&2; exit 1; fi
docker exec "$id" pg_dump -U omnyadesk -d omnyadesk -Fc > "$dest"
test -s "$dest"
chmod 600 "$dest"
sha256sum "$dest" > "$dest.sha256"
echo 'S30_BACKUP_CREATED=PASS'
echo 'S30_BACKUP_FILENAME='"$(basename "$dest")"
# Retention is manual until automated schedule is formally provisioned.
