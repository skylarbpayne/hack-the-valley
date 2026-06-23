#!/usr/bin/env bash
# Export the production Hack the Valley D1 database before any migration/deploy.
# Output may contain private participant data. Do not commit backup artifacts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/_d1-wrangler-config.sh
. "${ROOT}/scripts/_d1-wrangler-config.sh"

load_cloudflare_env

DB_NAME="${HTV_D1_DATABASE_NAME:-hack-the-valley}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
OUTPUT_DIR="${D1_BACKUP_DIR:-artifacts/d1-backups/${STAMP}-${SHA}}"
OUTPUT_SQL="${OUTPUT_DIR}/${DB_NAME}.sql"
mkdir -p "$OUTPUT_DIR"

TMP_CONFIG="$(mktemp /tmp/htv-wrangler.XXXXXX.toml)"
trap 'rm -f "$TMP_CONFIG"' EXIT
make_resolved_wrangler_config "$TMP_CONFIG" "$DB_NAME"

echo "Backing up remote D1 database '${DB_NAME}' to ${OUTPUT_SQL}"
echo "Backup files may contain private data. Keep them out of git and public logs."

npx wrangler d1 export "$DB_NAME" \
  --remote \
  --config "$TMP_CONFIG" \
  --output "$OUTPUT_SQL" \
  --skip-confirmation 2>&1 | sed -E 's#https://[^[:space:]]+#[REDACTED_SIGNED_EXPORT_URL]#g'

if [[ ! -s "$OUTPUT_SQL" ]]; then
  echo "Backup failed: export file is missing or empty: ${OUTPUT_SQL}" >&2
  exit 1
fi

if ! grep -Eq 'CREATE TABLE|INSERT INTO' "$OUTPUT_SQL"; then
  echo "Backup failed sanity check: export has no CREATE TABLE or INSERT INTO statements." >&2
  exit 1
fi

sha256_file "$OUTPUT_SQL" > "${OUTPUT_SQL}.sha256"
"${ROOT}/scripts/verify-d1-backup.sh" "$OUTPUT_SQL" > "${OUTPUT_DIR}/verification.json"

echo "Backup complete: ${OUTPUT_SQL}"
echo "Checksum: ${OUTPUT_SQL}.sha256"
echo "Verification: ${OUTPUT_DIR}/verification.json"
