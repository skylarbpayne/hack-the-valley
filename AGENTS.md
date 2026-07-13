# AGENTS.md

Repository instructions for humans and coding agents working on Hack the Valley.

## Database source of truth

- `migrations/*.sql` is the only source of truth for the D1 schema.
- Do not add or restore a hand-maintained `schema.sql`. A fresh database is built by applying the ordered migrations from `0001` onward.
- Every schema or data change must be a new, forward-only numbered migration. Never rewrite a migration that may already have been applied.
- Validate migration changes with `npm run db:migrations:check`; it applies every migration to a throwaway local D1 store and runs integrity fixtures.
- Historical plans may mention the removed `schema.sql`; those are records of past work, not current instructions.
- Remote migrations, production data changes, and deploys require explicit approval.

## Local development and testing

From a clean checkout:

```bash
npm ci
npm test
npm run check
npm run db:migrations:check
cp .dev.vars.example .dev.vars
npm run db:bootstrap:local
npm run dev
```

`db:bootstrap:local` is intentionally different from a plain `wrangler d1 migrations apply --local`: it applies the ordered migrations into Wrangler's normal local state and seeds compatibility rows required by historical data migrations. Run it once for a clean local state. If `.wrangler/state` already exists, keep using it or intentionally remove that ignored local directory before rebuilding; never point the bootstrap at a remote database.

Wrangler serves the app at <http://localhost:8788>. Useful surfaces:

- `/` — public site
- `/events` — events and signup flow
- `/login/?next=/admin` — local login
- `/admin` — organizer UI

For a local signed-in admin workflow:

1. Keep the non-secret development auth flags from `.dev.vars.example`; they make the login page display a local-only code instead of requiring Resend.
2. Open `/login/?next=/admin`, request a code for `dev@example.com`, and leave the dev server running.
3. In another terminal, grant that local user a role:

   ```bash
   HTV_SUPER_ADMIN_EMAIL=dev@example.com \
     npm run roles:seed-admin -- --local --apply
   ```

4. Enter the displayed code and test the admin surface.

Do not use `--remote`, real production credentials, or production data for local acceptance. External integrations such as Resend and R2 may remain unconfigured unless the specific test requires them.

## Completion gate

Before claiming a change is ready:

1. Run `npm test`.
2. Run `npm run check`.
3. Run `npm run db:migrations:check` when migrations or persistence behavior changed.
4. For UI/API work, start `npm run dev`, exercise the affected route against local D1, and record the concrete browser/API result.
5. Confirm `git diff --check` is clean.
