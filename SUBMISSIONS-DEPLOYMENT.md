# Hack the Valley Submissions Portal

This branch adds a scrappy-but-polished submission portal to the existing Cloudflare Worker + Assets site.

## URLs

- Participant page: `/submit`
- Admin page: `/admin-submissions`
- Submission API: `/api/submissions`
- Upload API: `/api/upload`
- Private media proxy: `/api/media?key=...`

## What participants can submit

Required:

- Team name
- Project title
- Contact email
- Team members
- Track
- Short description
- At least one uploaded media file or one media/demo link

Optional:

- GitHub repo link
- Live demo link
- YouTube/Loom/Drive/Canva media fallback link
- Demo video upload
- Screenshot/image uploads
- Judge notes

Uploads go to Cloudflare R2. Metadata goes to Cloudflare D1.

## Practical upload limit

The upload endpoint is intentionally capped at **100MB per file** by default because Cloudflare request limits are real. Larger demo videos should be submitted as YouTube/Loom/Drive links through the same form. This keeps the participant flow one-page instead of duct-taping Dropbox onto the side.

You can change this with `MAX_UPLOAD_MB`, but do not raise it without checking the Cloudflare plan request-body limit first.

## Cloudflare setup without the stupid localhost OAuth dance

Preferred path for remote/agent work: use a Cloudflare API token in a local ignored file. Wrangler browser OAuth redirects to `localhost` on the human's browser machine, which is exactly why Discord back-and-forth is miserable here.

1. In Cloudflare Dashboard, create a **custom API token** scoped to the account that owns `hack-the-valley`.
2. Give it account permissions for:
   - `D1:Edit` / `D1 Write`
   - `Workers R2 Storage:Edit` / `R2 Storage Write`
   - `Workers Scripts:Edit` / `Workers Scripts Write`
3. Copy `.cloudflare.env.example` to `.cloudflare.env` and fill in `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` locally. Do **not** commit it or paste it into chat.
4. Lock it down and verify:

```bash
cp .cloudflare.env.example .cloudflare.env
chmod 600 .cloudflare.env
# edit .cloudflare.env locally
./scripts/check-cloudflare-auth.sh
./scripts/setup-submissions-cloudflare.sh
```

The setup script auto-loads `.cloudflare.env`, so no `wrangler login` is needed.

## One-command Cloudflare setup with existing Wrangler auth

If Wrangler is already authenticated on the same machine running the command, this also works:

From the repo root:

```bash
npm install
./scripts/setup-submissions-cloudflare.sh
```

The setup script will:

1. verify Cloudflare auth
2. create/ensure the R2 bucket `hack-the-valley-submission-media`
3. create or reuse the D1 database `hack-the-valley-submissions`
4. write the D1/R2 bindings into `wrangler.toml`
5. apply `schema.sql`
6. generate and set Worker secret `SUBMISSIONS_ADMIN_TOKEN`
7. deploy the Worker
8. print the participant/admin URLs and token

If you want to avoid deploying, stop after the manual resource/schema steps and deploy separately with your normal Worker Git flow.

If the D1 database already exists and Wrangler does not print its ID, rerun with:

```bash
D1_DATABASE_ID=<database-id> ./scripts/setup-submissions-cloudflare.sh
```

Get the ID with:

```bash
npx wrangler d1 list
```

## Manual setup

Create resources:

```bash
npx wrangler r2 bucket create hack-the-valley-submission-media
npx wrangler d1 create hack-the-valley-submissions
```

Add the printed D1 database ID and R2 bucket binding to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "SUBMISSIONS_DB"
database_name = "hack-the-valley-submissions"
database_id = "<database-id>"

[[r2_buckets]]
binding = "SUBMISSIONS_MEDIA"
bucket_name = "hack-the-valley-submission-media"
```

Apply schema:

```bash
npx wrangler d1 execute hack-the-valley-submissions --remote --file=schema.sql
```

Set admin token:

```bash
openssl rand -hex 24
npx wrangler secret put SUBMISSIONS_ADMIN_TOKEN --name hack-the-valley
```

Deploy:

```bash
npx wrangler deploy --name hack-the-valley --keep-vars
```

## Admin usage

1. Open `/admin-submissions`.
2. Paste the `SUBMISSIONS_ADMIN_TOKEN` printed by setup.
3. Click **Load submissions**.
4. Use **Download CSV** for judging/export.
5. Open uploaded media links from each submission card.

Do not share the admin token. Anyone with it can view uploaded media.

## Local validation

```bash
npm test
```

Local end-to-end upload testing requires local D1/R2 bindings through Wrangler. The helper/unit tests cover validation, auth, CSV escaping, and JSON response behavior. For live smoke after deploy:

1. Open `/submit`.
2. Submit a test project with one small image.
3. Open `/admin-submissions` with the token.
4. Verify the submission appears.
5. Open the media link.
6. Download CSV and verify the row is present.
