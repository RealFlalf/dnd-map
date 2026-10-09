#!/bin/sh
# Runs in the "backup" container: once a day a database dump and an archive of the uploaded
# images go to deploy/backups on the host; copies older than BACKUP_KEEP_DAYS are removed.
# Restoring is described in docs/deploy.md.
set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

backup() {
  stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
  pg_dump --format=custom --file="/backups/db-$stamp.dump.partial"
  mv "/backups/db-$stamp.dump.partial" "/backups/db-$stamp.dump"
  tar -czf "/backups/uploads-$stamp.tar.gz.partial" -C /data uploads
  mv "/backups/uploads-$stamp.tar.gz.partial" "/backups/uploads-$stamp.tar.gz"
  find /backups -name 'db-*.dump' -mtime "+$KEEP_DAYS" -delete
  find /backups -name 'uploads-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
  echo "backup $stamp done"
}

while true; do
  backup || echo "backup failed" >&2
  sleep 86400
done
