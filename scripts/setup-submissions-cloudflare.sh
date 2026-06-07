#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-hack-the-valley}"
D1_NAME="${D1_NAME:-hack-the-valley}"
D1_BINDING="${D1_BINDING:-HTV_DB}"
R2_BUCKET="${R2_BUCKET:-hack-the-valley-submission-media}"
ADMIN_TOKEN="${HTV_ADMIN_TOKEN:-${SUBMISSIONS_ADMIN_TOKEN:-}}"

# Prefer a local API-token env file over Wrangler browser OAuth. Browser OAuth is
# painful from agents/remote shells because Cloudflare redirects to localhost on
# the human's machine, not necessarily the machine running Wrangler.
if [[ -f .cloudflare.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .cloudflare.env
  set +a
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required. Install Node.js/npm first." >&2
  exit 1
fi

if [[ -z "${ADMIN_TOKEN}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    ADMIN_TOKEN="$(openssl rand -hex 24)"
  else
    ADMIN_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
)"
  fi
fi

echo "==> Checking Cloudflare auth"
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Using CLOUDFLARE_API_TOKEN from environment/.cloudflare.env; no browser OAuth needed."
elif [[ -z "${CI:-}" ]]; then
  echo "No CLOUDFLARE_API_TOKEN found. If this is a remote/agent shell, do not use browser OAuth over chat." >&2
  echo "Create .cloudflare.env from .cloudflare.env.example, then rerun this script." >&2
fi
npx wrangler whoami >/dev/null

echo "==> Ensuring R2 bucket exists: ${R2_BUCKET}"
R2_LIST="$(npx wrangler r2 bucket list 2>&1)"
if ! R2_LIST_TEXT="${R2_LIST}" python3 - "${R2_BUCKET}" <<'PY'
import os
import re
import sys
bucket = sys.argv[1]
text = os.environ.get('R2_LIST_TEXT', '')
pattern = r'name:\s*' + re.escape(bucket) + r'(\s|$)'
raise SystemExit(0 if re.search(pattern, text) else 1)
PY
then
  npx wrangler r2 bucket create "${R2_BUCKET}"
fi

D1_ID="${HTV_D1_DATABASE_ID:-${D1_DATABASE_ID:-}}"
if [[ -z "${D1_ID}" && -f wrangler.toml ]]; then
  D1_ID="$(python3 - "${D1_NAME}" <<'PY'
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

if [[ -z "${D1_ID}" ]]; then
  echo "==> Creating D1 database: ${D1_NAME}"
  D1_OUTPUT="$(npx wrangler d1 create "${D1_NAME}" 2>&1 || true)"
  echo "${D1_OUTPUT}"
  D1_ID="$(D1_OUTPUT_TEXT="${D1_OUTPUT}" python3 - <<'PY'
import os
import re
text = os.environ.get('D1_OUTPUT_TEXT', '')
patterns = [
    r'database_id\s*=\s*"([0-9a-fA-F-]{32,36})"',
    r'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
]
for pattern in patterns:
    m = re.search(pattern, text)
    if m:
        print(m.group(1))
        raise SystemExit
PY
)"
else
  echo "==> Using D1 database already configured in wrangler.toml: ${D1_NAME}"
fi

if [[ -z "${D1_ID}" ]]; then
  echo "Could not parse D1 database_id from wrangler output." >&2
  echo "If the database already exists, get the ID with:" >&2
  echo "  npx wrangler d1 list" >&2
  echo "Then rerun:" >&2
  echo "  HTV_D1_DATABASE_ID=<id> $0" >&2
  exit 1
fi

echo "==> Writing D1/R2 bindings into wrangler.toml"
python3 - "${D1_ID}" "${D1_NAME}" "${R2_BUCKET}" <<'PY'
from pathlib import Path
import re
import sys

d1_id, d1_name, r2_bucket = sys.argv[1:]
path = Path('wrangler.toml')
text = path.read_text()
text = re.sub(r'\n# Submissions portal setup:[\s\S]*$', '', text)

# Remove previous generated app/submissions bindings so the script is rerunnable after
# partial setup failures.
blocks = []
for block in re.split(r'(?=\n\[\[)', text):
    if '[[d1_databases]]' in block and ('binding = "SUBMISSIONS_DB"' in block or 'binding = "HTV_DB"' in block):
        continue
    if '[[r2_buckets]]' in block and 'binding = "SUBMISSIONS_MEDIA"' in block:
        continue
    blocks.append(block)
text = ''.join(blocks).rstrip() + '\n\n'

text += f'''[[d1_databases]]
binding = "HTV_DB"
database_name = "{d1_name}"
database_id = "{d1_id}"

[[r2_buckets]]
binding = "SUBMISSIONS_MEDIA"
bucket_name = "{r2_bucket}"
'''
path.write_text(text)
PY

echo "==> Applying D1 migrations"
npx wrangler d1 migrations apply "${D1_BINDING}" --remote

echo "==> Setting Worker admin-token secret"
printf '%s' "${ADMIN_TOKEN}" | npx wrangler secret put HTV_ADMIN_TOKEN --name "${PROJECT_NAME}"

echo "==> Deploying Worker ${PROJECT_NAME}"
npx wrangler deploy --name "${PROJECT_NAME}" --keep-vars

echo
echo "Done. Save this admin token somewhere safe:"
echo "${ADMIN_TOKEN}"
echo
echo "Participant page: https://hackthevalley.org/submit"
echo "Admin page:       https://hackthevalley.org/admin-submissions"
echo "Worker route:      https://hackthevalley.org/submit"
