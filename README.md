# Hack the Valley 2026 - Website

Professional landing page for Hack the Valley 2026, a 1-day student innovation event in Bakersfield, CA.

## Event Details

- **Date:** May 30, 2026
- **Location:** Bakersfield, California
- **Students:** 50+ participants
- **Format:** 7:30 AM check-in; 8:30 AM - 6:00 PM program with mentorship and workshops
- **Grand Prize:** $500
- **Funding:** Sponsor-supported / community-supported
- **Focus:** Build, Create, Innovate

## Development

**Prerequisites:** Node.js and npm. A Cloudflare account is needed for deployment, not local development.

From a clean checkout:

```bash
npm ci
npm test
npm run check
npm run db:migrations:check
cp .dev.vars.example .dev.vars
npm run db:bootstrap:local
npm run dev
```

Visit <http://localhost:8788>. Wrangler stores the local D1 database under the ignored `.wrangler/` directory; these commands do not touch production.

Use `db:bootstrap:local` for a fresh local database rather than plain `wrangler d1 migrations apply --local`. The bootstrap applies the ordered migrations into Wrangler's normal local state and adds compatibility fixtures needed by historical data migrations. Run it once per clean local state; if `.wrangler/state` already exists, keep using it or intentionally remove that ignored local directory before rebuilding.

To test signed-in admin routes without Resend:

1. Open <http://localhost:8788/login/?next=/admin> and request a code for `dev@example.com`. The local-only code appears on the page because `.dev.vars.example` enables development auth.
2. In another terminal, grant that local user a role:

   ```bash
   HTV_SUPER_ADMIN_EMAIL=dev@example.com \
     npm run roles:seed-admin -- --local --apply
   ```

3. Enter the displayed code, then test `/admin`.

See [`AGENTS.md`](AGENTS.md) for the canonical local-testing checklist and database rules. Do not use `--remote` for local acceptance.

**Deployment:**
```bash
npm run deploy
```

## Project submissions portal

This repo includes a Cloudflare Worker + Assets/D1/R2 submission portal:

- Participant page: `/submit`
- Admin page: `/admin-submissions`
- Media uploads: R2 via `/api/upload`
- Metadata/export: D1 via `/api/submissions`

Setup/deploy instructions live in [`SUBMISSIONS-DEPLOYMENT.md`](SUBMISSIONS-DEPLOYMENT.md). The quick path is:

```bash
npm ci
cp .cloudflare.env.example .cloudflare.env
# fill CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN locally; do not commit it
./scripts/check-cloudflare-auth.sh
./scripts/setup-hack-the-valley-d1.sh
```

## Event signup platform

The current `/events` page includes the existing event archive plus dynamic upcoming events from the event/signup backend:

- Public upcoming events + signup form: `/events`
- Admin page: `/admin`
- Event APIs: `/api/events`, `/api/events/:slug`, `/api/events/:slug/signups`
- App storage: D1 binding `HTV_DB`, database `hack-the-valley`, with submissions/events/signups tables
- Email list sync: Resend via `RESEND_API_KEY`; per-event signup history stays in `HTV_DB`

Production setup after approval:

```bash
./scripts/setup-hack-the-valley-d1.sh
```

CI/CD backs up production D1 before applying migrations or deploying, and a scheduled workflow snapshots production D1 daily with 30-day retention. Backup artifacts are private but contain participant data; see [`docs/production-data-recovery.md`](docs/production-data-recovery.md) before merging schema/data changes. Then set Worker secrets `RESEND_API_KEY` and the optional recovery `HTV_ADMIN_TOKEN`, seed confirmed D1 admin roles with `npm run roles:seed-admin -- --apply`, create the real event, and smoke signup + CSV export + Resend contact creation.

Existing project submissions from the old `hack-the-valley-submissions` D1 database need one explicit data migration into the new app DB:

```bash
./scripts/migrate-submissions-to-app-db.sh        # dry run
./scripts/migrate-submissions-to-app-db.sh --apply
```

## Content Sources

Event details and sponsorship information are tracked in Skyvault under `1_Projects/Hack the Valley.md` and the current run-of-show Google Doc.

## Architecture

Static site with Cloudflare Worker + Assets API routes:
- Static assets in `public/`
- `worker.js` routes deployed `/api/*` requests to `functions/api/`
- Tailwind CSS via CDN
- Cloudflare Worker + Assets hosting

## Brand

Modern tech aesthetic with energetic colors (blue, cyan, orange) and clean typography (Inter font).
