#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-hack-the-valley}"
DB_BINDING="${DB_BINDING:-HTV_DB}"

cat <<MSG
This prepares the Hack the Valley event/signup tables in the single app D1 database.
Database binding: ${DB_BINDING}
Use scripts/setup-hack-the-valley-d1.sh first if the database does not exist yet.
It does NOT ask for or print secret values.
MSG

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required" >&2
  exit 1
fi

if [[ ! -d migrations ]]; then
  echo "Missing migrations/ directory" >&2
  exit 1
fi

if [[ ! -f wrangler.toml ]]; then
  echo "Missing wrangler.toml" >&2
  exit 1
fi

echo "Checking Wrangler auth…"
npx wrangler whoami >/dev/null

if ! grep -q "binding = \"${DB_BINDING}\"" wrangler.toml; then
  echo "Missing ${DB_BINDING} binding in wrangler.toml. Run scripts/setup-hack-the-valley-d1.sh first." >&2
  exit 1
fi

echo "Applying unapplied D1 migrations to ${DB_BINDING}…"
npx wrangler d1 migrations apply "${DB_BINDING}" --remote

cat <<MSG

Now configure Worker secrets for Worker: ${PROJECT_NAME}

Required:
  npx wrangler secret put HTV_ADMIN_TOKEN --name ${PROJECT_NAME}
  npx wrangler secret put RESEND_API_KEY --name ${PROJECT_NAME}

CI/CD:
  GitHub Actions runs tests, applies D1 migrations, then deploys Worker + Assets on pushes to main.

Smoke after deploy:
  1. GET /api/events should return JSON
  2. Create Hack Hours at Panera from /admin
  3. Open /events/hack-hours-panera
  4. Submit a test signup
  5. Export CSV from admin
  6. Confirm the signup row exists in HTV_DB and the opted-in contact exists in Resend
MSG
