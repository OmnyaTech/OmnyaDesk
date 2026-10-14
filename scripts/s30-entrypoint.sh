#!/bin/sh
set -eu
: "${DB_HOST:=db}"
: "${DB_NAME:=omnyadesk}"
: "${DB_USER:=omnyadesk}"
if [ ! -s /run/secrets/db_password ]; then
 echo 'Database password secret not mounted' >&2
 exit 78
fi
password="$(cat /run/secrets/db_password)"
case "$password" in
 *[!a-f0-9]*|'') echo 'Database secret must be hexadecimal' >&2; exit 78 ;;
esac
authority="//${DB_USER}:${password}@${DB_HOST}:5432/${DB_NAME}"
export DATABASE_URL="postgresql:${authority}"
unset authority
unset password
exec "$@"
