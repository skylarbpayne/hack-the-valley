#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-hack-the-valley}"
DB_NAME="${DB_NAME:-hack-the-valley}"
DB_BINDING="${DB_BINDING:-HTV_DB}"
DB_LOCATION="${DB_LOCATION:-wnam}"

cat <<MSG
This creates or reuses the single Hack the Valley app D1 database and applies migrations.
Database name: ${DB_NAME}
Worker binding: ${DB_BINDING}

It does not print or request secret values.
MSG

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required" >&2
  exit 1
fi

if [[ ! -f wrangler.toml ]]; then
  echo "Missing wrangler.toml; run from the repo root." >&2
  exit 1
fi

npx wrangler whoami >/dev/null

DB_ID="$(npx wrangler d1 list --json | python3 -c 'import json,sys; name=sys.argv[1]; data=json.load(sys.stdin); matches=[d for d in data if d.get("name")==name]; print(matches[0].get("uuid") or matches[0].get("id") if matches else "")' "${DB_NAME}")"

if [[ -z "${DB_ID}" ]]; then
  echo "Creating D1 database ${DB_NAME}…"
  npx wrangler d1 create "${DB_NAME}" --location "${DB_LOCATION}"
  DB_ID="$(npx wrangler d1 list --json | python3 -c 'import json,sys; name=sys.argv[1]; data=json.load(sys.stdin); matches=[d for d in data if d.get("name")==name]; print(matches[0].get("uuid") or matches[0].get("id") if matches else "")' "${DB_NAME}")"
fi

if [[ -z "${DB_ID}" ]]; then
  echo "Could not resolve D1 database id for ${DB_NAME}" >&2
  exit 1
fi

echo "Resolved ${DB_NAME}: ${DB_ID}"

python3 - "${DB_BINDING}" "${DB_NAME}" "${DB_ID}" <<'PY'
from pathlib import Path
import re
import sys
binding, name, dbid = sys.argv[1:4]
p = Path('wrangler.toml')
text = p.read_text()
# Remove existing D1 blocks for the old submissions DB or this binding.
blocks = []
for block in re.split(r'(?=\n\[\[)', text):
    if '[[d1_databases]]' in block and ('binding = "SUBMISSIONS_DB"' in block or f'binding = "{binding}"' in block):
        continue
    blocks.append(block)
text = ''.join(blocks).rstrip() + f'''

[[d1_databases]]
binding = "{binding}"
database_name = "{name}"
database_id = "{dbid}"
'''
p.write_text(text + '\n')
PY

echo "Applying D1 migrations…"
npx wrangler d1 migrations apply "${DB_BINDING}" --remote

cat <<MSG

Done.
CI/CD resolves this database by name on each deploy and patches the deploy config with:
  ${DB_BINDING} -> ${DB_NAME} (${DB_ID})

Worker secrets still need to be set on the Worker, not Pages:
  npx wrangler secret put HTV_ADMIN_TOKEN --name ${PROJECT_NAME}
  npx wrangler secret put RESEND_API_KEY --name ${PROJECT_NAME}
MSG
