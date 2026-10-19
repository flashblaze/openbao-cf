#!/usr/bin/env bash
# Restore drill: load a backup into database bao_restore and start openbao-restore on :8201.
# Leaves openbao-restore running; the caller tears it down.
# Usage: BAO_SEAL_KEY=... bash scripts/restore-drill.sh <backup.ndjson>
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BAO_SEAL_KEY:?set BAO_SEAL_KEY (the seal key of the instance that produced the backup)}"
BACKUP=${1:?usage: restore-drill.sh <backup.ndjson>}
[ -f "$BACKUP" ] || { echo "no such file: $BACKUP" >&2; exit 1; }
export BAO_SEAL_KEY

docker compose up -d --wait postgres
docker compose exec -T postgres createdb -U bao bao_restore 2>/dev/null || echo "bao_restore already exists"
bun scripts/restore.ts "$BACKUP" postgres://bao:bao@127.0.0.1:55432/bao_restore
docker compose --profile restore up -d --build openbao-restore

for _ in $(seq 1 180); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8201/v1/sys/health || true)" = 200 ] && {
    echo "Restored OpenBao at http://127.0.0.1:8201"
    exit 0
  }
  sleep 1
done
docker compose logs openbao-restore | tail -30
echo "openbao-restore never became healthy (200) on :8201" >&2
exit 1
