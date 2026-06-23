#!/usr/bin/env bash
# Restore a D1 backup into a NEW Cloudflare D1 database.
# This script intentionally does not overwrite the production database in place.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat >&2 <<'EOF'
Usage:
  HTV_RESTORE_I_UNDERSTAND=new-database-restore scripts/restore-d1-backup-to-new-db.sh path/to/backup.sql [new-db-name]

This creates/imports into a new D1 database. It does not repoint production.
After verification, update HTV_D1_DATABASE_ID / wrangler config intentionally and deploy with approval.
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

if [[ "${HTV_RESTORE_I_UNDERSTAND:-}" != "new-database-restore" ]]; then
  echo "Refusing restore without HTV_RESTORE_I_UNDERSTAND=new-database-restore" >&2
  usage
  exit 2
fi

BACKUP_SQL="$1"
NEW_DB_NAME="${2:-hack-the-valley-restore-$(date -u +%Y%m%dT%H%M%SZ)}"

# shellcheck source=scripts/_d1-wrangler-config.sh
. "${ROOT}/scripts/_d1-wrangler-config.sh"
load_cloudflare_env

"${ROOT}/scripts/verify-d1-backup.sh" "$BACKUP_SQL" >/dev/null

echo "Creating new D1 database '${NEW_DB_NAME}' for restore."
CREATE_OUTPUT="$(npx wrangler d1 create "$NEW_DB_NAME" 2>&1)"
printf '%s\n' "$CREATE_OUTPUT"

echo "Importing backup into '${NEW_DB_NAME}'."
npx wrangler d1 execute "$NEW_DB_NAME" --remote --file "$BACKUP_SQL" --yes

echo "Verifying restored database '${NEW_DB_NAME}' with row counts."
npx wrangler d1 execute "$NEW_DB_NAME" --remote --command "SELECT 'events' AS table_name, COUNT(*) AS count FROM events UNION ALL SELECT 'event_instances', COUNT(*) FROM event_instances UNION ALL SELECT 'signups', COUNT(*) FROM signups UNION ALL SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'projects', COUNT(*) FROM projects;" --json

echo
cat <<EOF
Restore import complete into new DB: ${NEW_DB_NAME}

Next steps, after human approval:
1. Copy the database_id from the create output above.
2. Set HTV_D1_DATABASE_ID to that new ID in the deployment environment.
3. Deploy the Worker.
4. Smoke live routes before deleting or archiving the old DB.
EOF
