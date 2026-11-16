#!/usr/bin/env bash
# Prove the newest backup restores: load it into a scratch database, check the
# schema and the ontology seed are there, then drop the scratch database.
#
#   GEV_BACKUP_DIR=/mnt/backup/gev bash scripts/platform-restore-test.sh
#
# Needs an admin connection in GEV_ADMIN_DATABASE_URL (a role that can CREATE
# DATABASE), or the compose `postgres` service. Never touches the live
# database.
set -euo pipefail

dir="${GEV_BACKUP_DIR:-./.gev-backups}"
latest="$(ls -1t "$dir"/gev-*.dump 2>/dev/null | head -n1 || true)"
[[ -n "$latest" ]] || { echo "no backup found in $dir" >&2; exit 1; }
( cd "$dir" && sha256sum --check "$(basename "$latest").sha256" )

scratch="gev_restore_test_$$"
if [[ -n "${GEV_ADMIN_DATABASE_URL:-}" ]]; then
  run() { psql "$GEV_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -tA "$@"; }
  restore() { pg_restore --no-owner --dbname="$1" "$latest"; }
  scratch_url="$(printf '%s' "$GEV_ADMIN_DATABASE_URL" | sed -E "s#/[^/?]+(\\?|$)#/$scratch\\1#")"
else
  run() { docker compose --profile platform exec -T postgres psql -U gev -d postgres -v ON_ERROR_STOP=1 -tA "$@"; }
  restore() { docker compose --profile platform exec -T postgres pg_restore --no-owner -U gev -d "$1" < "$latest"; }
  scratch_url=""
fi
cleanup() { run -c "DROP DATABASE IF EXISTS $scratch" > /dev/null || true; }
trap cleanup EXIT

run -c "CREATE DATABASE $scratch" > /dev/null
restore "${scratch_url:-$scratch}"

q() {
  if [[ -n "$scratch_url" ]]; then psql "$scratch_url" -v ON_ERROR_STOP=1 -tA -c "$1"
  else docker compose --profile platform exec -T postgres psql -U gev -d "$scratch" -v ON_ERROR_STOP=1 -tA -c "$1"; fi
}
types="$(q 'SELECT count(*) FROM gev.object_type')"
migs="$(q 'SELECT count(*) FROM public.gev_migration')"
[[ "$types" -ge 1 && "$migs" -ge 1 ]] || { echo "restore is missing data (types=$types migrations=$migs)" >&2; exit 1; }
echo "restore ok: $latest ($migs migrations, $types object types)"
