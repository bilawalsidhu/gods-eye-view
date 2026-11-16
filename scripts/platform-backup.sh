#!/usr/bin/env bash
# Nightly logical backup of the platform database.
#
#   GEV_BACKUP_DIR=/mnt/backup/gev bash scripts/platform-backup.sh
#
# Writes <dir>/gev-YYYYMMDD-HHMMSS.dump (pg_dump custom format, compressed),
# a .sha256 beside it, and prunes dumps older than GEV_BACKUP_KEEP_DAYS
# (default 30). Uses the compose `postgres` service when GEV_DATABASE_URL is
# not set. Exit status is non-zero on any failure, so cron can mail it.
set -euo pipefail

dir="${GEV_BACKUP_DIR:-./.gev-backups}"
keep="${GEV_BACKUP_KEEP_DAYS:-30}"
stamp="$(date -u +%Y%m%d-%H%M%S)"
file="$dir/gev-$stamp.dump"
mkdir -p "$dir"
umask 077

if [[ -n "${GEV_DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --compress=6 --no-owner --dbname="$GEV_DATABASE_URL" --file="$file.partial"
else
  docker compose --profile platform exec -T postgres \
    pg_dump --format=custom --compress=6 --no-owner -U gev gev > "$file.partial"
fi

# A dump that cannot be listed is not a backup.
pg_restore --list "$file.partial" > /dev/null
mv "$file.partial" "$file"
( cd "$dir" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )
find "$dir" -name 'gev-*.dump*' -mtime +"$keep" -delete
echo "backup ok: $file ($(du -h "$file" | cut -f1))"
