# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hack the Valley 2026 is a static landing page for a 300-student hackathon event in Bakersfield, California (April 12-14, 2026). The site is deployed to Cloudflare Pages using Wrangler.

## Development

**Local preview:**
```bash
npx wrangler pages dev ./public
```

**Deploy to Cloudflare:**
```bash
npx wrangler pages deploy ./public
```

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
