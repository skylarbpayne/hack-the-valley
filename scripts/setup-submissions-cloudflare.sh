#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-hack-the-valley}"
D1_NAME="${D1_NAME:-hack-the-valley-submissions}"
R2_BUCKET="${R2_BUCKET:-hack-the-valley-submission-media}"
ADMIN_TOKEN="${SUBMISSIONS_ADMIN_TOKEN:-}"

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
npx wrangler whoami >/dev/null

echo "==> Creating/ensuring R2 bucket: ${R2_BUCKET}"
npx wrangler r2 bucket create "${R2_BUCKET}" || true

echo "==> Creating D1 database: ${D1_NAME}"
D1_OUTPUT="$(npx wrangler d1 create "${D1_NAME}" 2>&1 || true)"
echo "${D1_OUTPUT}"

D1_ID="${D1_DATABASE_ID:-}"
if [[ -z "${D1_ID}" ]]; then
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
fi

if [[ -z "${D1_ID}" ]]; then
  echo "Could not parse D1 database_id from wrangler output." >&2
  echo "If the database already exists, get the ID with:" >&2
  echo "  npx wrangler d1 list" >&2
  echo "Then rerun:" >&2
  echo "  D1_DATABASE_ID=<id> $0" >&2
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
text = re.sub(r'\n# Submissions portal setup:[\s\S]*$', '', text).rstrip() + '\n\n'
text += f'''[[d1_databases]]
binding = "SUBMISSIONS_DB"
database_name = "{d1_name}"
database_id = "{d1_id}"

[[r2_buckets]]
binding = "SUBMISSIONS_MEDIA"
bucket_name = "{r2_bucket}"
'''
path.write_text(text)
PY

echo "==> Applying schema to remote D1"
npx wrangler d1 execute "${D1_NAME}" --remote --file=schema.sql

echo "==> Setting Pages admin-token secret"
printf '%s' "${ADMIN_TOKEN}" | npx wrangler pages secret put SUBMISSIONS_ADMIN_TOKEN --project-name "${PROJECT_NAME}"

echo "==> Deploying Pages project"
npx wrangler pages deploy ./public --project-name "${PROJECT_NAME}"

echo
echo "Done. Save this admin token somewhere safe:"
echo "${ADMIN_TOKEN}"
echo
echo "Participant page: https://${PROJECT_NAME}.pages.dev/submit.html"
echo "Admin page:       https://${PROJECT_NAME}.pages.dev/admin-submissions.html"
echo
echo "If a custom domain is attached, use the same paths on that domain."
