#!/usr/bin/env bash
set -euo pipefail

TARGET_DB="${TARGET_DB:-hack-the-valley}"
EVENT_SLUG="${EVENT_SLUG:-hack-the-valley-2026}"
EVENT_INSTANCE_ID="${EVENT_INSTANCE_ID:-}"
APPLY=0
SKIP_MIGRATIONS=0
ARTIFACT_DIR="${ARTIFACT_DIR:-artifacts/project-migration-$(date -u +%Y%m%dT%H%M%SZ)}"

usage() {
  cat <<'MSG'
Build Hack the Valley project/showcase rows from existing submissions in the app D1 database.

Default target: hack-the-valley
Default event slug: hack-the-valley-2026
Default mode: dry run. It exports a source backup and prepares idempotent SQL only.

Usage:
  ./scripts/migrate-projects-from-submissions.sh
  ./scripts/migrate-projects-from-submissions.sh --apply

Options:
  --apply             Write idempotent project/member/event-submission rows to the target database.
  --skip-migrations   Do not run D1 migrations before import.
  -h, --help          Show this help.

Environment overrides:
  TARGET_DB=<app-db-name>
  EVENT_SLUG=<event-slug>
  EVENT_INSTANCE_ID=<event-instance-id-or-empty>
  ARTIFACT_DIR=<path-for-backup-and-sql>

The script never deletes rows and never prints secret values.
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

mkdir -p "${ARTIFACT_DIR}"
SOURCE_JSON="${ARTIFACT_DIR}/backup-submissions.json"
IMPORT_SQL="${ARTIFACT_DIR}/import-projects.sql"
VERIFY_JSON="${ARTIFACT_DIR}/verify-project-links.json"
SUMMARY_JSON="${ARTIFACT_DIR}/summary.json"
TEMP_CONFIG=".wrangler.migration.toml"
DB_LIST_JSON="${ARTIFACT_DIR}/d1-list.json"
trap 'rm -f "${TEMP_CONFIG}"' EXIT

cat <<MSG
Migrating Hack the Valley project data from submissions
  target:         ${TARGET_DB}
  event_slug:     ${EVENT_SLUG}
  event_instance: ${EVENT_INSTANCE_ID:-<none>}
  mode:           $(if [[ "${APPLY}" == "1" ]]; then echo apply; else echo dry-run; fi)
  artifacts:      ${ARTIFACT_DIR}
MSG

echo "==> Checking Cloudflare auth"
npx wrangler whoami >/dev/null

echo "==> Resolving D1 database id for ${TARGET_DB}"
TARGET_DB_ID="${HTV_D1_DATABASE_ID:-}"
if [[ -z "${TARGET_DB_ID}" ]]; then
  npx wrangler d1 list --json > "${DB_LIST_JSON}"
  TARGET_DB_ID="$(python3 - "${DB_LIST_JSON}" "${TARGET_DB}" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text())
target = sys.argv[2]
rows = data if isinstance(data, list) else data.get("result", [])
for row in rows:
    if row.get("name") == target:
        print(row.get("uuid") or row.get("database_id") or row.get("id") or "")
        break
PY
)"
fi
if [[ -z "${TARGET_DB_ID}" ]]; then
  echo "Could not resolve D1 database id for ${TARGET_DB}" >&2
  exit 1
fi
python3 - "${TARGET_DB}" "${TARGET_DB_ID}" "${TEMP_CONFIG}" <<'PY'
import sys
from pathlib import Path

target_name, target_id, out = sys.argv[1:]
text = Path("wrangler.toml").read_text()
text = text.replace('database_name = "hack-the-valley"', f'database_name = "{target_name}"')
text = text.replace('database_id = "${HTV_D1_DATABASE_ID}"', f'database_id = "{target_id}"')
Path(out).write_text(text)
PY

if [[ "${SKIP_MIGRATIONS}" != "1" && "${APPLY}" == "1" ]]; then
  echo "==> Ensuring target app schema is migrated"
  npx wrangler d1 migrations apply "${TARGET_DB}" --remote --config "${TEMP_CONFIG}"
elif [[ "${APPLY}" != "1" ]]; then
  echo "==> Dry run: skipping remote D1 migrations"
fi

echo "==> Backing up existing submissions from ${TARGET_DB}"
npx wrangler d1 execute "${TARGET_DB}" --remote --json --config "${TEMP_CONFIG}" \
  --command "SELECT id, created_at, team_name, project_title, contact_email, track, payload_json, uploads_json, status FROM submissions ORDER BY created_at;" \
  > "${SOURCE_JSON}"

python3 - "${SOURCE_JSON}" "${IMPORT_SQL}" "${SUMMARY_JSON}" "${EVENT_SLUG}" "${EVENT_INSTANCE_ID}" <<'PY'
import json
import re
import sys
from pathlib import Path

source_path = Path(sys.argv[1])
sql_path = Path(sys.argv[2])
summary_path = Path(sys.argv[3])
event_slug = sys.argv[4]
event_instance_id = sys.argv[5] or None

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
    return None

def sql_value(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"

def slugify(value):
    slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")[:64]
    return slug or "submission"

def project_id_for(slug):
    return "prj_" + re.sub(r"[^a-zA-Z0-9_]+", "_", slug.replace("-", "_"))

def link_id_for(event_slug, instance_id, project_id, submission_id):
    raw = f"eps_{event_slug}_{instance_id or 'event'}_{project_id}_{submission_id or 'manual'}"
    return re.sub(r"[^a-zA-Z0-9_]+", "_", raw)

rows = find_results(json.loads(source_path.read_text())) or []
rows = [row for row in rows if isinstance(row, dict) and row.get("id")]
statements = []
projects = 0
members = 0
links = 0

event_title = " ".join(part.capitalize() for part in event_slug.replace("-", " ").split()) or event_slug
statements.append(
    "INSERT OR IGNORE INTO events (slug, title, description, status, created_at, updated_at) VALUES "
    f"({sql_value(event_slug)}, {sql_value(event_title)}, 'Project showcase imported from existing HTV submissions.', 'archived', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);"
)

for row in rows:
    payload = {}
    try:
        payload = json.loads(row.get("payload_json") or "{}")
    except Exception:
        payload = {}
    title = (row.get("project_title") or payload.get("projectTitle") or "").strip()
    if not title:
        continue
    slug = slugify(title)
    project_id = project_id_for(slug)
    team_name = row.get("team_name") or payload.get("teamName")
    description = payload.get("description")
    repo_url = payload.get("repoLink") or payload.get("repo_url") or payload.get("repository")
    demo_url = payload.get("demoLink") or payload.get("demo_url") or payload.get("demo") or payload.get("mediaLink")
    tracks = payload.get("tracks") or row.get("track")
    tracks_json = json.dumps(tracks if isinstance(tracks, list) else [part.strip() for part in str(tracks or "").split("|") if part.strip()])
    created_at = row.get("created_at") or "CURRENT_TIMESTAMP"
    now_expr = "CURRENT_TIMESTAMP"
    statements.append(
        "INSERT INTO projects (id, slug, title, team_name, description, repo_url, demo_url, tracks_json, canonical_submission_id, created_at, updated_at) VALUES "
        f"({sql_value(project_id)}, {sql_value(slug)}, {sql_value(title)}, {sql_value(team_name)}, {sql_value(description)}, {sql_value(repo_url)}, {sql_value(demo_url)}, {sql_value(tracks_json)}, {sql_value(row['id'])}, {sql_value(created_at)}, {now_expr}) "
        "ON CONFLICT(slug) DO UPDATE SET "
        "title=excluded.title, team_name=COALESCE(excluded.team_name, projects.team_name), description=COALESCE(excluded.description, projects.description), "
        "repo_url=COALESCE(excluded.repo_url, projects.repo_url), demo_url=COALESCE(excluded.demo_url, projects.demo_url), tracks_json=COALESCE(excluded.tracks_json, projects.tracks_json), "
        "canonical_submission_id=COALESCE(excluded.canonical_submission_id, projects.canonical_submission_id), updated_at=excluded.updated_at;"
    )
    projects += 1

    email = (row.get("contact_email") or payload.get("contactEmail") or "").strip().lower()
    if email:
        member_id = re.sub(r"[^a-zA-Z0-9_]+", "_", f"prm_{project_id}_{email}")
        statements.append(
            "INSERT INTO project_members (id, project_id, user_id, name, email, role, source, created_at) VALUES "
            f"({sql_value(member_id)}, {sql_value(project_id)}, NULL, {sql_value(payload.get('members') or team_name)}, {sql_value(email)}, 'owner', 'submission_migration', {sql_value(created_at)}) "
            "ON CONFLICT(project_id, email) DO UPDATE SET role=CASE WHEN project_members.role = 'owner' THEN project_members.role ELSE excluded.role END, source=excluded.source;"
        )
        members += 1

    link_id = link_id_for(event_slug, event_instance_id, project_id, row["id"])
    statements.append(
        "INSERT INTO event_project_submissions (id, event_slug, event_instance_id, project_id, submission_id, status, source, created_at, updated_at) VALUES "
        f"({sql_value(link_id)}, {sql_value(event_slug)}, {sql_value(event_instance_id)}, {sql_value(project_id)}, {sql_value(row['id'])}, {sql_value(row.get('status') or 'submitted')}, 'submission_migration', {sql_value(created_at)}, {now_expr}) "
        "ON CONFLICT(id) DO UPDATE SET status=excluded.status, source=excluded.source, updated_at=excluded.updated_at;"
    )
    links += 1

sql_path.write_text("\n".join(statements) + ("\n" if statements else ""))
summary = {
    "source_rows": len(rows),
    "project_upserts_prepared": projects,
    "member_upserts_prepared": members,
    "event_project_link_upserts_prepared": links,
    "event_slug": event_slug,
    "event_instance_id": event_instance_id,
    "backup": str(source_path),
    "sql": str(sql_path),
}
summary_path.write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
PY

if [[ "${APPLY}" != "1" ]]; then
  cat <<MSG
Dry run complete. No target data was changed.
Backup JSON: ${SOURCE_JSON}
Import SQL:  ${IMPORT_SQL}
Summary:     ${SUMMARY_JSON}
To apply after reviewing the backup and SQL:
  ./scripts/migrate-projects-from-submissions.sh --apply
MSG
  exit 0
fi

echo "==> Applying idempotent project migration SQL to ${TARGET_DB}"
npx wrangler d1 execute "${TARGET_DB}" --remote --config "${TEMP_CONFIG}" --file "${IMPORT_SQL}"

echo "==> Verifying event project links in ${TARGET_DB}"
npx wrangler d1 execute "${TARGET_DB}" --remote --json --config "${TEMP_CONFIG}" \
  --command "SELECT eps.event_slug, eps.event_instance_id, eps.project_id, eps.submission_id, eps.status, eps.source FROM event_project_submissions eps WHERE eps.event_slug = '${EVENT_SLUG//\'/\'\'}' ORDER BY eps.project_id;" \
  > "${VERIFY_JSON}"

python3 - "${SUMMARY_JSON}" "${VERIFY_JSON}" <<'PY'
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
    if isinstance(obj, list):
        for item in obj:
            rows = find_results(item)
            if rows is not None:
                return rows
    return []
summary = json.loads(Path(sys.argv[1]).read_text())
links = find_results(json.loads(Path(sys.argv[2]).read_text())) or []
submission_ids = {row.get("submission_id") for row in links if isinstance(row, dict) and row.get("submission_id")}
print(f"verified_event_project_links={len(submission_ids)} prepared_links={summary['event_project_link_upserts_prepared']}")
if len(submission_ids) < summary["event_project_link_upserts_prepared"]:
    raise SystemExit("Not all prepared project links are visible after migration")
PY

echo "Done. Project migration evidence is in ${ARTIFACT_DIR}."
