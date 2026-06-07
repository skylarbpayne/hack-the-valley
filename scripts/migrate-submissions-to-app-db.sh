#!/usr/bin/env bash
set -euo pipefail

SOURCE_DB="${SOURCE_DB:-hack-the-valley-submissions}"
TARGET_DB="${TARGET_DB:-hack-the-valley}"
APPLY=0
SKIP_MIGRATIONS=0

usage() {
  cat <<'MSG'
Migrate existing Hack the Valley project submissions from the old D1 database into the new app D1 database.

Default source: hack-the-valley-submissions
Default target: hack-the-valley

Usage:
  ./scripts/migrate-submissions-to-app-db.sh           # dry run: export source rows and build import SQL only
  ./scripts/migrate-submissions-to-app-db.sh --apply   # apply migrations, import rows, verify source IDs exist in target

Options:
  --apply             Actually write rows to the target database.
  --skip-migrations   Do not run D1 migrations before import.
  -h, --help          Show this help.

Environment overrides:
  SOURCE_DB=<old-db-name>
  TARGET_DB=<new-db-name>

Requires Cloudflare auth through CLOUDFLARE_API_TOKEN or Wrangler auth.
This script never prints secret values.
MSG
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    --skip-migrations)
      SKIP_MIGRATIONS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -f .cloudflare.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .cloudflare.env
  set +a
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required" >&2
  exit 1
fi

if [[ "${SOURCE_DB}" == "${TARGET_DB}" ]]; then
  echo "SOURCE_DB and TARGET_DB must differ" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
SOURCE_JSON="${TMP_DIR}/source-submissions.json"
TARGET_JSON="${TMP_DIR}/target-submissions.json"
IMPORT_SQL="${TMP_DIR}/import-submissions.sql"

cat <<MSG
Migrating Hack the Valley submissions
  source: ${SOURCE_DB}
  target: ${TARGET_DB}
  mode:   $(if [[ "${APPLY}" == "1" ]]; then echo apply; else echo dry-run; fi)
MSG

echo "==> Checking Cloudflare auth"
npx wrangler whoami >/dev/null

if [[ "${SKIP_MIGRATIONS}" != "1" ]]; then
  echo "==> Ensuring target app schema is migrated"
  npx wrangler d1 migrations apply "${TARGET_DB}" --remote
fi

echo "==> Exporting existing submissions from ${SOURCE_DB}"
npx wrangler d1 execute "${SOURCE_DB}" --remote --json \
  --command "SELECT id, created_at, team_name, project_title, contact_email, track, payload_json, uploads_json, status FROM submissions ORDER BY created_at;" \
  > "${SOURCE_JSON}"

python3 - "${SOURCE_JSON}" "${IMPORT_SQL}" <<'PY'
import json
import sys
from pathlib import Path

source_path = Path(sys.argv[1])
sql_path = Path(sys.argv[2])
data = json.loads(source_path.read_text())
columns = [
    "id",
    "created_at",
    "team_name",
    "project_title",
    "contact_email",
    "track",
    "payload_json",
    "uploads_json",
    "status",
]

def find_results(obj):
    if isinstance(obj, dict):
        results = obj.get("results")
        if isinstance(results, list):
            return results
        result = obj.get("result")
        if isinstance(result, list):
            for item in result:
                rows = find_results(item)
                if rows is not None:
                    return rows
        for value in obj.values():
            rows = find_results(value)
            if rows is not None:
                return rows
    elif isinstance(obj, list):
        for item in obj:
            rows = find_results(item)
            if rows is not None:
                return rows
    return None

rows = find_results(data) or []
rows = [row for row in rows if isinstance(row, dict) and row.get("id")]

def sql_value(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"

statements = [
    "BEGIN TRANSACTION;",
    "CREATE TABLE IF NOT EXISTS submissions (\n"
    "  id TEXT PRIMARY KEY,\n"
    "  created_at TEXT NOT NULL,\n"
    "  team_name TEXT NOT NULL,\n"
    "  project_title TEXT NOT NULL,\n"
    "  contact_email TEXT NOT NULL,\n"
    "  track TEXT NOT NULL,\n"
    "  payload_json TEXT NOT NULL,\n"
    "  uploads_json TEXT NOT NULL,\n"
    "  status TEXT NOT NULL DEFAULT 'submitted'\n"
    ");",
]

for row in rows:
    values = ", ".join(sql_value(row.get(column)) for column in columns)
    updates = ", ".join(f"{column}=excluded.{column}" for column in columns if column != "id")
    statements.append(
        f"INSERT INTO submissions ({', '.join(columns)}) VALUES ({values}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates};"
    )

statements.extend([
    "CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_submissions_track ON submissions(track);",
    "CREATE INDEX IF NOT EXISTS idx_submissions_contact_email ON submissions(contact_email);",
    "COMMIT;",
])

sql_path.write_text("\n".join(statements) + "\n")
print(len(rows))
PY

SOURCE_COUNT="$(python3 - "${SOURCE_JSON}" <<'PY'
import json,sys
from pathlib import Path

def find_results(obj):
    if isinstance(obj, dict):
        if isinstance(obj.get('results'), list):
            return obj['results']
        if isinstance(obj.get('result'), list):
            for item in obj['result']:
                rows = find_results(item)
                if rows is not None:
                    return rows
        for value in obj.values():
            rows = find_results(value)
            if rows is not None:
                return rows
    if isinstance(obj, list):
        for item in obj:
            rows = find_results(item)
            if rows is not None:
                return rows
    return []
rows = find_results(json.loads(Path(sys.argv[1]).read_text())) or []
print(len([r for r in rows if isinstance(r, dict) and r.get('id')]))
PY
)"

echo "==> Source rows found: ${SOURCE_COUNT}"

echo "==> Import SQL prepared: ${IMPORT_SQL}"

if [[ "${APPLY}" != "1" ]]; then
  cat <<MSG
Dry run complete. No target data was changed.
To run the migration:
  ./scripts/migrate-submissions-to-app-db.sh --apply
MSG
  exit 0
fi

echo "==> Importing rows into ${TARGET_DB}"
npx wrangler d1 execute "${TARGET_DB}" --remote --file "${IMPORT_SQL}"

echo "==> Verifying migrated IDs in ${TARGET_DB}"
npx wrangler d1 execute "${TARGET_DB}" --remote --json \
  --command "SELECT id FROM submissions ORDER BY id;" \
  > "${TARGET_JSON}"

python3 - "${SOURCE_JSON}" "${TARGET_JSON}" <<'PY'
import json
import sys
from pathlib import Path

def find_results(obj):
    if isinstance(obj, dict):
        if isinstance(obj.get("results"), list):
            return obj["results"]
        if isinstance(obj.get("result"), list):
            for item in obj["result"]:
                rows = find_results(item)
                if rows is not None:
                    return rows
        for value in obj.values():
            rows = find_results(value)
            if rows is not None:
                return rows
    elif isinstance(obj, list):
        for item in obj:
            rows = find_results(item)
            if rows is not None:
                return rows
    return []

source_rows = find_results(json.loads(Path(sys.argv[1]).read_text())) or []
target_rows = find_results(json.loads(Path(sys.argv[2]).read_text())) or []
source_ids = {row["id"] for row in source_rows if isinstance(row, dict) and row.get("id")}
target_ids = {row["id"] for row in target_rows if isinstance(row, dict) and row.get("id")}
missing = sorted(source_ids - target_ids)
print(f"source_ids={len(source_ids)} target_ids={len(target_ids)} migrated_ids_present={len(source_ids) - len(missing)}")
if missing:
    print("Missing IDs:", ", ".join(missing[:25]), file=sys.stderr)
    raise SystemExit(1)
PY

echo "Done. Existing submissions are present in ${TARGET_DB}."
