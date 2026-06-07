# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hack the Valley 2026 is a static landing page for a 50+ student one-day hackathon event in Bakersfield, California on May 30, 2026. The site is deployed as a Cloudflare Worker + Assets app using Wrangler.

## Development

**Install/test:**
```bash
npm install
npm test
```

**Local preview:**
```bash
npm run dev
```

**Deploy to Cloudflare:**
```bash
npm run deploy
```

## Event signup platform

The `/events` page is the canonical events surface. It combines the existing event archive with dynamic upcoming events from the event/signup backend.

- Event/signup API lives under `/api/events` and stores records in app D1 binding `HTV_DB` / database `hack-the-valley`.
- Admin UI lives at `/admin` and event create/export actions require `HTV_ADMIN_TOKEN`. Legacy `/admin-events.html` redirects to `/admin`.
- Public signups sync opted-in emails to Resend using `RESEND_API_KEY`; per-event signup history lives in `HTV_DB`.
- Do not create a separate root `/events.html`; preserve the existing `/events` information architecture.

## Submissions portal

The project submission flow lives on `/submit` with a private admin review page at `/admin-submissions`.

- Uploads go to R2 through `/api/upload`.
- Submission metadata goes to D1 through `HTV_DB`.
- Admin media access goes through `/api/media` and requires `SUBMISSIONS_ADMIN_TOKEN`.
- Full Cloudflare setup/deploy instructions are in `SUBMISSIONS-DEPLOYMENT.md`.

## Architecture

Static site with Cloudflare Worker + Assets API routes:
- Static files live in `public/`
- `worker.js` routes deployed `/api/*` requests to files under `functions/api/`
- Tailwind CSS via CDN
- Cloudflare Worker + Assets hosting

## Brand Guidelines

- **Colors:** Tech Blue (#2563eb), Dark Navy (#1e293b), Cyan (#06b6d4), Orange (#f59e0b)
- **Fonts:** Inter (headings and body)
- **Tone:** Energetic, innovative, community-focused
- **Identity:** Bakersfield, Central Valley tech community, student innovation
