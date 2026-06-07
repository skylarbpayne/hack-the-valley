#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-hack-the-valley}"
DB_NAME="${DB_NAME:-hack-the-valley-events}"
MIGRATION_FILE="${MIGRATION_FILE:-migrations/0001_event_signups.sql}"

cat <<MSG
This script prepares the Hack the Valley event-signup backend.
It will create/locate the D1 database, write the HTV_DB binding into wrangler.toml,
and apply the event/signups migration.
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

D1_ID="${D1_DATABASE_ID:-}"
if [[ -z "$D1_ID" ]]; then
  D1_ID="$(python3 - "$DB_NAME" <<'PY'
from pathlib import Path
import re
import sys
name = sys.argv[1]
text = Path('wrangler.toml').read_text()
for block in re.findall(r'\[\[d1_databases\]\][\s\S]*?(?=\n\[\[|\n\[|\Z)', text):
    db_name = re.search(r'database_name\s*=\s*"([^"]+)"', block)
    db_id = re.search(r'database_id\s*=\s*"([0-9a-fA-F-]{32,36})"', block)
    if db_name and db_id and db_name.group(1) == name:
        print(db_id.group(1))
        raise SystemExit
PY
)"
fi

if [[ -z "$D1_ID" ]]; then
  echo "Creating D1 database if needed: $DB_NAME"
  set +e
  CREATE_OUTPUT=$(npx wrangler d1 create "$DB_NAME" 2>&1)
  CREATE_STATUS=$?
  set -e
  printf '%s\n' "$CREATE_OUTPUT"
  if [[ $CREATE_STATUS -ne 0 ]] && ! grep -qi "already" <<<"$CREATE_OUTPUT"; then
    echo "D1 create failed" >&2
    exit $CREATE_STATUS
  fi
  D1_ID="$(CREATE_OUTPUT_TEXT="$CREATE_OUTPUT" python3 - <<'PY'
import os
import re
text = os.environ.get('CREATE_OUTPUT_TEXT', '')
for pattern in (
    r'database_id\s*=\s*"([0-9a-fA-F-]{32,36})"',
    r'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
):
    match = re.search(pattern, text)
    if match:
        print(match.group(1))
        raise SystemExit
PY
)"
else
  echo "Using event D1 database already configured in wrangler.toml or D1_DATABASE_ID: $DB_NAME"
fi

if [[ -z "$D1_ID" ]]; then
  echo "Could not determine D1 database_id." >&2
  echo "If the database already exists, run: npx wrangler d1 list" >&2
  echo "Then rerun: D1_DATABASE_ID=<id> $0" >&2
  exit 1
fi

echo "Writing HTV_DB binding into wrangler.toml"
python3 - "$D1_ID" "$DB_NAME" <<'PY'
from pathlib import Path
import re
import sys

d1_id, db_name = sys.argv[1:]
path = Path('wrangler.toml')
text = path.read_text()
blocks = []
for block in re.split(r'(?=\n\[\[)', text):
    if '[[d1_databases]]' in block and 'binding = "HTV_DB"' in block:
        continue
    blocks.append(block)
text = ''.join(blocks).rstrip() + '\n\n'
text += f'''[[d1_databases]]
binding = "HTV_DB"
database_name = "{db_name}"
database_id = "{d1_id}"
'''
path.write_text(text)
PY

echo "Applying migration to remote D1 database…"
npx wrangler d1 execute "$DB_NAME" --remote --file "$MIGRATION_FILE"

cat <<MSG

Now configure Cloudflare secrets/env for project: $PROJECT_NAME

Required:
  - Secret: HTV_ADMIN_TOKEN
  - Secret: RESEND_API_KEY

Deploy only after those are set, then smoke:
  1. GET /api/events should return JSON
  2. Create Hack Hours at Panera from /admin
  3. Open /events?event=hack-hours-panera
  4. Submit a test signup
  5. Export CSV from admin
  6. Confirm the signup row exists in HTV_DB and the opted-in contact exists in Resend
MSG
