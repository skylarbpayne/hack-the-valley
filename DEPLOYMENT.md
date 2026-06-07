# Hack the Valley 2026 - Deployment Guide

## Recent Updates (2026-02-18)

**Changes made:**
1. ✅ Removed all sponsor sections and references
2. ✅ Deleted sponsors.html page  
3. ✅ Updated navigation (removed sponsor links)
4. ✅ Confirmed 1-day event format (May 30, 2026; 7:30 AM check-in; 8:30 AM - 6:00 PM program)
5. ✅ Confirmed $500 grand prize (appropriate for self-funded event)
6. ✅ Form backend verified working (Cloudflare Workers + MailChannels)

**Testing completed:**
- ✅ Local dev server running (http://localhost:8788)
- ✅ Tailscale accessible (https://skylars-mac-mini.taile4d789.ts.net:8790/)
- ✅ Form submission tested successfully
- ✅ All sponsor references removed from HTML
- ✅ Navigation updated correctly
- ✅ 1-day format displayed prominently

## Deployment to Production

### Option 1: Cloudflare Pages (via Git)

1. **Push to GitHub:**
   ```bash
   cd /Users/skylarpayne/chiefs/palmer-workspace/tmp/hack-the-valley
   git push origin main
   ```

2. **Cloudflare will auto-deploy** from the connected GitHub repo

### Option 2: Direct Deploy (wrangler CLI)

```bash
cd /Users/skylarpayne/chiefs/palmer-workspace/tmp/hack-the-valley
npx wrangler pages deploy ./public --project-name hack-the-valley
```

## Environment Variables (Production)

For production deployment, set these in Cloudflare Pages/Workers:

Legacy registration notification fallback:
- `REGISTRATION_TO_EMAIL`: Email to receive legacy registrations (default: registrations@hackthevalley.com)
- `REGISTRATION_FROM_EMAIL`: Sender email address (default: noreply@hackthevalley.com)

Event signup platform:
- D1 binding `HTV_DB`: event and signup storage
- `HTV_ADMIN_TOKEN`: organizer/admin bearer token
- `RESEND_API_KEY`: Resend contact sync

**Note:** MailChannels requires domain verification in production. See: https://mailchannels.zendesk.com/hc/en-us/articles/4565898358413-Sending-Email-from-Cloudflare-Workers-using-MailChannels-Send-API

## Form Backend Details

**Endpoint:** `/api/register`  
**Method:** POST  
**Handler:** `functions/api/register.js`

**Features:**
- ✅ Input validation (required fields, email format)
- ✅ HTML escaping (XSS protection)
- ✅ Email delivery via MailChannels API
- ✅ Backup logging (console.log structured records)
- ✅ Graceful degradation (if email fails, still logs data)

**Response:**
```json
{
  "success": true,
  "deliveredByEmail": false,
  "message": "Registration received"
}
```

## Event Signup Platform

Public/admin surfaces:
- Existing events page with dynamic upcoming event signups: `/events`
- Organizer/admin page: `/admin`
- Admin event create/update: `POST /api/events`, `PATCH /api/events/:slug`
- Public signup: `POST /api/events/:slug/signups`
- Admin signup list/export: `GET /api/events/:slug/signups`, `GET /api/events/:slug/signups?format=csv`

Setup after approval:

```bash
./scripts/setup-event-platform.sh
```

Then set `HTV_ADMIN_TOKEN` and `RESEND_API_KEY`, deploy, create the real Hack Hours event from `/admin`, submit a test signup from `/events?event=<slug>`, export CSV, and confirm the signup row exists in HTV_DB and the opted-in contact was created/updated in Resend.

## Current Status

**Local Testing:** ✅ Complete and working  
**Git Commit:** ✅ Committed (04ac658)  
**Ready to Deploy:** ✅ Yes

**Next Steps:**
1. Push to GitHub: `git push origin main` (if using Pages Git integration)
2. OR Deploy directly: `npx wrangler pages deploy ./public`
3. Verify production deployment
4. Test form submission in production (with proper email credentials)

## Architecture Notes

- **Static files:** `public/` directory
- **Functions:** `functions/api/` (Cloudflare Workers)
- **No build step:** Pure HTML/CSS/JS with Tailwind CDN
- **Hosting:** Cloudflare Pages
- **Email:** MailChannels (free tier for Cloudflare Workers)

## Support

- **Event contact:** registrations@hackthevalley.com
- **Website issues:** See CLAUDE.md for development guidance
