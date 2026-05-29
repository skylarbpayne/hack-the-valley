# Hack the Valley submission portal

This repo now includes a scrappy Cloudflare-native project submission portal:

- Participant page: `/submit.html`
- API endpoint: `POST /api/submissions`
- Admin table: `/admin-submissions.html`
- Admin JSON: `GET /api/admin/submissions`
- CSV export: `GET /api/admin/export`
- Private media fetch: `GET /api/admin/media?key=...`

## What participants can submit

Required:

- team name
- primary contact name/email
- project title
- track
- short description

Optional but encouraged:

- team members
- demo/deployed URL
- GitHub/repo URL
- slides/deck URL
- up to 5 images/screenshots
- one demo video

Upload limits are enforced in both browser and API:

- images: 15 MB each
- video: 500 MB

If a student has cursed Wi-Fi, tell them to paste YouTube/Loom/Drive links too. Links are often more reliable than giant uploads.

## Cloudflare bindings

Production needs three bindings:

| Binding | Type | Purpose |
| --- | --- | --- |
| `SUBMISSIONS_BUCKET` | R2 bucket | Stores uploaded images/videos |
| `SUBMISSIONS_DB` | D1 database | Stores submission metadata |
| `ADMIN_TOKEN` | env var / secret | Protects admin JSON, CSV, and media links |

Optional:

| Binding | Type | Purpose |
| --- | --- | --- |
| `SUBMISSIONS_DEADLINE_ISO` | env var | Locks new submissions after an ISO timestamp, e.g. `2026-05-30T17:00:00-07:00` |

## One-time Cloudflare setup

Run these only after Skylar approves Cloudflare mutation. They create real infra.

```bash
# from repo root
npx wrangler login

# Create storage primitives
npx wrangler r2 bucket create hack-the-valley-submissions
npx wrangler d1 create hack-the-valley-submissions

# Apply schema. Use the database name returned/created above.
npx wrangler d1 execute hack-the-valley-submissions --remote --file=./migrations/0001_submissions.sql
```

Then in Cloudflare Pages dashboard for the `hack-the-valley` project:

1. Settings → Functions → D1 database bindings
   - variable name: `SUBMISSIONS_DB`
   - database: `hack-the-valley-submissions`
2. Settings → Functions → R2 bucket bindings
   - variable name: `SUBMISSIONS_BUCKET`
   - bucket: `hack-the-valley-submissions`
3. Settings → Environment variables
   - `ADMIN_TOKEN`: generate a long random value
   - optional `SUBMISSIONS_DEADLINE_ISO`

Generate an admin token locally:

```bash
python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
```

## Local validation

Static/tests only:

```bash
npm test
npm run validate
```

Cloudflare Pages local function compile:

```bash
npx wrangler pages functions build functions --outdir /tmp/htv-functions-build --compatibility-date=2026-02-17
rm -rf /tmp/htv-functions-build
```

Browser dev server with local bindings:

```bash
npx wrangler pages dev ./public \
  --compatibility-date=2026-02-17 \
  --r2=SUBMISSIONS_BUCKET \
  --d1=SUBMISSIONS_DB \
  --binding=ADMIN_TOKEN=dev-admin-token
```

Then test:

- participant form: `http://localhost:8788/submit.html`
- admin page: `http://localhost:8788/admin-submissions.html`
- admin token: `dev-admin-token`

Note: `pages dev --d1` gives you a local D1 binding, but the browser flow still needs the `submissions` table. For production setup, use the remote schema command above after creating the real D1 database. For local browser testing, either add temporary real binding IDs to `wrangler.toml` and run `wrangler d1 execute ... --local --file=...`, or rely on `npm run validate`, which exercises the API with fake D1/R2 bindings.

## Deploy paths

### Git-backed Cloudflare Pages

Push a branch/PR to GitHub. Once merged, Cloudflare Pages should deploy from the connected repo.

```bash
git push origin <branch>
```

### Direct Pages deploy

```bash
npx wrangler pages deploy ./public --project-name hack-the-valley
```

## Admin workflow

1. Open `/admin-submissions.html`.
2. Enter the admin token.
3. Click `Load` to see submissions.
4. Use media links to review uploaded images/videos.
5. Click `CSV Export` for the judge/admin spreadsheet.

Admin endpoints accept `Authorization: Bearer <ADMIN_TOKEN>`. Media URLs on the admin page include the token as a query string for simple browser opening, which is pragmatic for a same-day hackathon but not fancy. Rotate the token after the event if it gets shared too widely.

## Notes / limits

- Uploaded media is private in R2 and served only through the admin media endpoint.
- The API stores object keys in D1, not public URLs.
- Very large phone videos can still fail if the browser/network/request limit chokes. Keep the external video link field visible as the fallback.
- There is no judging rubric workflow here; this is the intake/export layer only.
