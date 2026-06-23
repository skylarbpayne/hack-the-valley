#!/usr/bin/env bash
# Shared helpers for production D1 backup/restore scripts.
# Do not echo environment variables from here; Cloudflare env files may contain secrets.

set -euo pipefail

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

load_cloudflare_env() {
  if [[ -f .cloudflare.env ]]; then
    set -a
    # shellcheck disable=SC1091
    . ./.cloudflare.env
    set +a
  fi
  if [[ -f .cloudflare.env.local ]]; then
    set -a
    # shellcheck disable=SC1091
    . ./.cloudflare.env.local
    set +a
  fi
}

resolve_d1_database_id() {
  local db_name="$1"
  local d1_id="${HTV_D1_DATABASE_ID:-${D1_DATABASE_ID:-}}"
  if [[ -n "$d1_id" ]]; then
    printf '%s' "$d1_id"
    return 0
  fi

  local list_json
  list_json="$(npx wrangler d1 list --json 2>/dev/null || true)"
  LIST_JSON="$list_json" python3 - "$db_name" <<'PY'
import json
import os
import sys

name = sys.argv[1]
try:
    rows = json.loads(os.environ.get("LIST_JSON") or "[]")
except json.JSONDecodeError:
    rows = []
for row in rows:
    if row.get("name") == name:
        print(row.get("uuid") or row.get("id") or "", end="")
        break
PY
}

make_resolved_wrangler_config() {
  local output_path="$1"
  local db_name="${2:-hack-the-valley}"
  local d1_id
  d1_id="$(resolve_d1_database_id "$db_name")"
  python3 - "$output_path" "$d1_id" <<'PY'
from pathlib import Path
import sys

out = Path(sys.argv[1])
d1_id = sys.argv[2]
text = Path("wrangler.toml").read_text()
if d1_id:
    text = text.replace('${HTV_D1_DATABASE_ID}', d1_id)
out.write_text(text)
PY
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file"
  else
    shasum -a 256 "$file"
  fi
}
