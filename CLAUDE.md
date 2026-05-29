# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hack the Valley 2026 is a static landing page for a 50+ student one-day hackathon event in Bakersfield, California on May 30, 2026. The site is deployed to Cloudflare Pages using Wrangler.

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

## Submissions portal

The project submission flow lives on `/submit.html` with a private admin review page at `/admin-submissions.html`.

- Uploads go to R2 through `/api/upload`.
- Submission metadata goes to D1 through `/api/submissions`.
- Admin media access goes through `/api/media` and requires `SUBMISSIONS_ADMIN_TOKEN`.
- Full Cloudflare setup/deploy instructions are in `SUBMISSIONS-DEPLOYMENT.md`.

## Architecture

This is a simple static site with no build step:
- All static files live in `public/`
- Single-page HTML site (`public/index.html`) using Tailwind CSS via CDN
- Images in `public/images/`

## Brand Guidelines

- **Colors:** Tech Blue (#2563eb), Dark Navy (#1e293b), Cyan (#06b6d4), Orange (#f59e0b)
- **Fonts:** Inter (headings and body)
- **Tone:** Energetic, innovative, community-focused
- **Identity:** Bakersfield, Central Valley tech community, student innovation
