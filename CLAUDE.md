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
- Admin UI lives at `/admin` and event create/export actions require an `htv_session` user with an active global `admin` or `super_admin` role. Legacy `/admin-events.html` redirects to `/admin`.
- Public signups sync opted-in emails to Resend using `RESEND_API_KEY`; per-event signup history lives in `HTV_DB`.
- Do not create a separate root `/events.html`; preserve the existing `/events` information architecture.

## Submissions portal

The project submission flow lives on `/submit` with a private admin review page at `/admin-submissions`.

- Uploads go to R2 through `/api/upload`.
- Submission metadata goes to D1 through `HTV_DB`.
- Admin media access goes through `/api/media`; legacy token access is kept for submissions/recovery paths, while the main admin surface is session + roles based.
- Full Cloudflare setup/deploy instructions are in `SUBMISSIONS-DEPLOYMENT.md`.

## Blog

The blog is a manual list of static HTML pages under `public/blog/` (no database, no build step). See `public/blog/README.md` for how to author a post.

- The index at `/blog/` renders cards from `public/blog/posts.json`.
- Each post is `public/blog/<slug>/index.html`, served at `/blog/<slug>`. Article bodies are wrapped in `<!-- POST:START -->`/`<!-- POST:END -->` markers, and every post carries a "Sign up for our next event" CTA linking to `/events`.
- "Publishing" a post as an email blast goes through `POST /api/blog/broadcast` (admin session + roles required), which reuses the post content to create and schedule a Resend broadcast. The control lives in the "Blog email blast" section of the `/admin` organizer page. Pass `{ dryRun: true }` to preview the rendered email without sending.
- Blasts are never sent immediately: a real send requires `scheduledAt` at least 10 minutes in the future, validated server-side (missing/invalid/past is a 422). The target audience is resolved (read-only) *before* the send-log row is reserved, so an audience misconfiguration can't leave a forever-`pending` row that blocks retries. Sends are idempotent on `slug + scheduledAt` via the `blog_broadcast_sends` table (migration `0025`); a duplicate is a 409, and if Resend creation succeeds but the send fails, the `broadcastId` is recorded/returned for recovery (`send_failed`).
- The send-log status is a real state machine, not a claim that mail went out. Accepting a scheduled send records `scheduled` (never `sent`). A cron trigger (`worker.js` `scheduled` → `reconcileBroadcastSends`, every 15 min) polls Resend's broadcast status and advances rows: Resend `queued` → `sending`, `sent` → `sent` (terminal), and a `draft` revert or a 404 → `canceled` (terminal). Transient poll failures leave the row for the next run; `last_reconciled_at` records the last poll.
- Broadcast env vars: `RESEND_API_KEY` (shared with the mailing list) and `RESEND_BROADCAST_FROM` (a verified sender). The audience is auto-discovered when the Resend account has exactly one audience; set `RESEND_AUDIENCE_ID` only to disambiguate when there are several. Optional `SITE_BASE_URL` makes in-email links/images absolute (defaults to the request origin).

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
