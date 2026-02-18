# Hack the Valley 2026 - Website

Professional landing page for Hack the Valley 2026, a self-funded, 1-day innovation event in Bakersfield, CA.

## Event Details

- **Date:** April 12, 2026 (1-day event: 9 AM - 5 PM)
- **Location:** Bakersfield, California
- **Students:** 300 participants
- **Format:** 8-hour sprint with mentorship and workshops
- **Grand Prize:** $500
- **Funding:** Self-funded (no sponsors)
- **Focus:** Build, Create, Innovate

## Development

**Prerequisites:**
- Node.js & npm
- Cloudflare account (for deployment)

**Local Development:**
```bash
npx wrangler pages dev ./public
```

Visit: http://localhost:8788

**Deployment:**
```bash
npx wrangler pages deploy ./public
```

## Content Sources

Event details and sponsorship information sourced from:
- `~/palmer/workspace/BC-Hackathon-Sponsorship-Package.md`
- `~/palmer/workspace/BC-Hackathon-COMPLETE-PACKAGE-INDEX.md`

## Architecture

Static site with no build step:
- Pure HTML/CSS/JavaScript
- Tailwind CSS via CDN
- Cloudflare Pages hosting

## Brand

Modern tech aesthetic with energetic colors (blue, cyan, orange) and clean typography (Inter font).
