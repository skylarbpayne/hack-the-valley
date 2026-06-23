#!/usr/bin/env bash
# Validate a D1 SQL export without printing row contents.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 path/to/backup.sql" >&2
  exit 2
fi

BACKUP_SQL="$1"
if [[ ! -s "$BACKUP_SQL" ]]; then
  echo "Backup file is missing or empty: ${BACKUP_SQL}" >&2
  exit 1
fi

python3 - "$BACKUP_SQL" <<'PY'
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

backup = Path(sys.argv[1])
required_tables = {
    "events",
    "event_instances",
    "signups",
    "users",
    "projects",
    "event_project_submissions",
}
with tempfile.NamedTemporaryFile(suffix=".sqlite3") as tmp:
    conn = sqlite3.connect(tmp.name)
    script = backup.read_text(errors="replace")
    conn.executescript(script)
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    tables = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        if not row[0].startswith("sqlite_")
    }
    missing = sorted(required_tables - tables)
    counts = {}
    for table in sorted(tables):
        try:
            counts[table] = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        except sqlite3.DatabaseError:
            counts[table] = None
    result = {
        "backup": str(backup),
        "integrity_check": integrity,
        "table_count": len(tables),
        "required_tables_present": not missing,
        "missing_required_tables": missing,
        "row_counts": counts,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    if integrity != "ok" or missing:
        sys.exit(1)
PY
