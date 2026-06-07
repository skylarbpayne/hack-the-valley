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

**Prerequisites:**
- Node.js & npm
- Cloudflare account (for deployment)

**Install + tests:**
```bash
npm install
npm test
npm run check
```

**Local Development:**
```bash
npm run dev
```

Visit: http://localhost:8788

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
npm install
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

CI/CD applies D1 migrations before each Worker deploy. Then set Worker secrets `HTV_ADMIN_TOKEN` and `RESEND_API_KEY`, create the real event, and smoke signup + CSV export + Resend contact creation.

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
