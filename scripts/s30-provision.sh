#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$HOME/.local/share/omnyadesk/s30"
mkdir -p "$root"/{release,secrets,config,backups,manifests}
if [ ! -e "$root/secrets/db_password" ]; then
  openssl rand -hex 32 > "$root/secrets/db_password"
fi
chmod 600 "$root/secrets/db_password"
if ! grep -Eq '^[0-9a-f]{64}$' "$root/secrets/db_password"; then
  echo 'Invalid S30 database secret' >&2; exit 78
fi
if [ "$(stat -c %a "$root/secrets/db_password")" != 600 ]; then
  echo 'Secret permissions not restrictive' >&2; exit 78
fi
echo 'S30_PRIVATE_ROOT_READY=PASS'
echo 'S30_SECRET_EXTERNAL_CHMOD600=PASS'
