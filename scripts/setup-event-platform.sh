#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-hack-the-valley}"
DB_NAME="${DB_NAME:-hack-the-valley-submissions}"
MIGRATION_FILE="${MIGRATION_FILE:-migrations/0001_event_signups.sql}"

cat <<MSG
This script prepares the Hack the Valley event-signup tables in the existing app D1 database.
It reuses the SUBMISSIONS_DB binding/database; it does not create a second event database.
Run it only after Skylar approves production backend setup.
It does NOT ask for or print secret values.
MSG

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required" >&2
  exit 1
fi

if [[ ! -f "$MIGRATION_FILE" ]]; then
  echo "Missing migration file: $MIGRATION_FILE" >&2
  exit 1
fi

if [[ ! -f wrangler.toml ]]; then
  echo "Missing wrangler.toml" >&2
  exit 1
fi

echo "Checking Wrangler auth…"
npx wrangler whoami >/dev/null

if ! grep -q 'binding = "SUBMISSIONS_DB"' wrangler.toml; then
  echo "Missing SUBMISSIONS_DB binding in wrangler.toml. Run submissions setup first or add the existing app D1 binding." >&2
  exit 1
fi

echo "Applying event/signup migration to existing remote D1 database: $DB_NAME"
npx wrangler d1 execute "$DB_NAME" --remote --file "$MIGRATION_FILE"

cat <<MSG

Now configure Worker secrets for Worker: $PROJECT_NAME

Required:
  printf '%s' '<admin-password>' | npx wrangler secret put HTV_ADMIN_TOKEN --name $PROJECT_NAME
  printf '%s' '<resend-api-key>' | npx wrangler secret put RESEND_API_KEY --name $PROJECT_NAME

Deploy via Worker deployment/CI, then smoke:
  1. GET /api/events should return JSON
  2. Create Hack Hours at Panera from /admin
  3. Open /events?event=hack-hours-panera
  4. Submit a test signup
  5. Export CSV from admin
  6. Confirm the signup row exists in SUBMISSIONS_DB and the opted-in contact exists in Resend
MSG
