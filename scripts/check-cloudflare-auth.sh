#!/usr/bin/env bash
set -euo pipefail

if [[ -f .cloudflare.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .cloudflare.env
  set +a
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is not set."
  echo
  echo "Preferred setup: copy .cloudflare.env.example to .cloudflare.env and fill it in locally."
  echo "Do not paste tokens into chat."
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "CLOUDFLARE_ACCOUNT_ID is not set. Wrangler may work if the token is single-account, but setup is more reliable with it." >&2
fi

echo "==> Verifying Cloudflare API token without printing it"
if [[ "${CLOUDFLARE_API_TOKEN}" == cfat_* ]]; then
  if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    echo "Token looks account-owned (cfat_), so CLOUDFLARE_ACCOUNT_ID is required for the verifier endpoint." >&2
    exit 1
  fi
  VERIFY_URL="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens/verify"
else
  VERIFY_URL="https://api.cloudflare.com/client/v4/user/tokens/verify"
fi

VERIFY_JSON="$(curl -fsS "${VERIFY_URL}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H 'Content-Type: application/json')"

VERIFY_JSON="${VERIFY_JSON}" python3 - <<'PY'
import json
import os
import sys
payload = json.loads(os.environ['VERIFY_JSON'])
if not payload.get('success'):
    print('Cloudflare token verification failed.', file=sys.stderr)
    print(json.dumps(payload, indent=2), file=sys.stderr)
    raise SystemExit(1)
result = payload.get('result') or {}
print(f"Token status: {result.get('status', 'verified')}")
print(f"Token id: {result.get('id', '[not returned]')}")
PY

echo "==> Checking Wrangler sees Cloudflare auth"
npx wrangler whoami >/dev/null

echo "Cloudflare auth is ready for setup-hack-the-valley-d1.sh"
