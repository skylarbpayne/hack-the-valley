# Production data recovery runbook

Hack the Valley production data lives in Cloudflare D1 database `hack-the-valley` through Worker binding `HTV_DB`.

This repo must be able to answer three questions before any risky deploy/migration:

1. Do we have a fresh backup?
2. Did the backup import cleanly into SQLite?
3. If production breaks, how do we restore without overwriting more data?

## Policy

- No production D1 migration/deploy should run without a backup artifact from the current production DB.
- Production D1 should also have a scheduled daily snapshot, retained for 30 days.
- Backup files contain private participant data. Never commit them and never paste contents into chat/logs.
- Restore is into a **new D1 database first**. Do not overwrite the production DB in place.
- Repointing production to a restored DB requires explicit human approval.

## Automatic pre-deploy backup

The main deploy workflow now runs this before migrations:

```bash
./scripts/backup-production-d1.sh
```

Then it uploads `artifacts/d1-backups/` as a private GitHub Actions artifact named:

```text
htv-d1-backup-<main-commit-sha>
```

Retention is 30 days.

## Daily snapshots

A separate scheduled workflow, `.github/workflows/d1-snapshot.yml`, runs once per day and uploads a private artifact named:

```text
htv-d1-snapshot-<github-run-id>-<run-attempt>
```

Retention is 30 days. This is the rolling restore window for non-deploy-related data loss or accidental production mutation.

The workflow also supports manual `workflow_dispatch` runs when we want a fresh snapshot immediately before risky manual operations.

## Manual backup

From the repo root:

```bash
./scripts/backup-production-d1.sh
```

The script:

- sources `.cloudflare.env` / `.cloudflare.env.local` if present without printing secrets
- exports remote D1 with `wrangler d1 export`
- writes the SQL dump under `artifacts/d1-backups/<timestamp>-<sha>/`
- writes a SHA-256 checksum
- imports the dump into a temporary local SQLite DB and runs `PRAGMA integrity_check`
- writes table row counts to `verification.json` without printing row contents

## Verify a backup

```bash
./scripts/verify-d1-backup.sh artifacts/d1-backups/<backup-dir>/hack-the-valley.sql
```

Expected result:

- `integrity_check: "ok"`
- required tables present: `users`, `events`, `event_instances`, `signups`, `projects`, `event_project_submissions`
- table row counts emitted, no row contents emitted

## Restore path

Restore into a new database:

```bash
HTV_RESTORE_I_UNDERSTAND=new-database-restore \
  ./scripts/restore-d1-backup-to-new-db.sh artifacts/d1-backups/<backup-dir>/hack-the-valley.sql
```

The restore script:

1. Verifies the backup locally first.
2. Creates a new Cloudflare D1 database named `hack-the-valley-restore-<timestamp>` unless a name is passed.
3. Imports the SQL dump into that new DB.
4. Runs count-only verification against the restored DB.
5. Prints next steps for repointing production.

It intentionally does **not** update production binding or deploy.

## Production repoint checklist

Only after approval:

1. Copy the new restored D1 `database_id` from the restore output.
2. Set `HTV_D1_DATABASE_ID` for the deployment environment to the restored database ID.
3. Deploy the Worker.
4. Smoke live read routes:
   - `/`
   - `/events/`
   - `/projects/`
   - unsigned `/api/me` returns 401, not 500
5. Verify count-only D1 queries against the restored DB.
6. Keep the old DB around until the restore is proven.

## Before merging future D1/schema work

Require:

- `npm run check`
- `npm test`
- `npm run db:migrations:check` to apply every migration sequentially against a fresh temporary local D1 store and run integrity fixtures
- PR body states whether production D1 will be mutated on merge
- post-merge deploy workflow produced a backup artifact before migrations
- scheduled snapshot workflow is still enabled on `main`
