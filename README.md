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

This repo includes a Cloudflare Pages/D1/R2 submission portal:

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
./scripts/setup-submissions-cloudflare.sh
```

## Content Sources

Event details and sponsorship information are tracked in Skyvault under `1_Projects/Hack the Valley.md` and the current run-of-show Google Doc.

## Architecture

Static site with no build step:
- Pure HTML/CSS/JavaScript
- Tailwind CSS via CDN
- Cloudflare Pages hosting

## Brand

Modern tech aesthetic with energetic colors (blue, cyan, orange) and clean typography (Inter font).
