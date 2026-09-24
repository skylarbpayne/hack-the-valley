# Sponsorship prototype: local review

This prototype uses the existing Cloudflare Worker, D1 database, R2 media binding,
and session-based admin login. All sample businesses and people are fictional.
The dedicated store lives in ignored `.wrangler/sponsorship-prototype/`, separate
from normal development state. No production credentials or email service are
needed.

## Start and sign in

Requires Node.js 22.13 or later (the tests use built-in `node:sqlite`).

```sh
npm ci
npm run sponsorships:setup:local
npm run sponsorships:dev
```

Open <http://localhost:8788/login/?next=/admin-sponsorships>. Request a login code
for one of the following identities and enter the code displayed by the local
login page. Keep the server running throughout the login flow.

| Email | Access |
| --- | --- |
| `danny@example.com` | Danny Demo, super admin |
| `alex@example.com` | Alex Demo, admin |
| `member@example.com` | Ordinary member; sponsorship access is denied |

Then open <http://localhost:8788/admin-sponsorships>. Both admins can manage every
sponsorship motion. Each motion has one owner; one admin can own many motions.
The assigned owner determines who receives an overdue reminder preview.

## Demo data

- Ten fictional businesses with reusable primary contacts and every outreach
  status: Not contacted, Contacted, Followup, Interest, Negotiating, Lost,
  Committed, and Paid.
- Current **HTV 2027** and archived **HTV 2026** campaigns, including one business
  reused across both years with separate outreach and payment histories.
- Cash, in-kind and mixed commitments; partial and full payments; invoice and
  check references; a private demo PNG logo.
- Dates relative to the first setup's Pacific calendar day: overdue, due today,
  future, missing and completed follow-ups. Old dates on Lost/Paid and archived
  motions demonstrate reminder exclusions.

Re-running setup applies only missing migrations and inserts only missing
fixture IDs. It preserves edits, revoked fixture roles and original follow-up
dates. Restarting the server preserves data and logo files. Setup is never run
automatically when the server starts.

To intentionally remove this prototype's database and uploaded media:

```sh
npm run sponsorships:reset:local
npm run sponsorships:setup:local
```

Stop the prototype server before resetting. Reset accepts no path or target;
it removes only `.wrangler/sponsorship-prototype/`.

## Review walkthrough

1. Sign in as Danny; filter Outreach to overdue Followup records owned by Danny.
2. Add a business and primary contact, assign an admin, and set its next action
   and follow-up date. Record work completed in its activity timeline.
3. Edit the reusable contact and add it to a second active campaign. Verify
   its prior campaign's notes, activity, ownership and payment history remain
   separate. Archived campaigns stay readable.
4. Mark a motion Committed. Enter a cash commitment, check/invoice reference,
   and partial received amount. Full payment changes its status to Paid;
   reducing the received amount returns it to Committed. A second save does
   not duplicate the commitment or increase the received amount.
5. Record an in-kind or mixed contribution, mark fulfillment, and upload a PNG,
   JPEG or WebP logo up to 5 MB. The logo is visible only to signed-in admins.
6. Generate overdue reminder previews. Inspect the per-owner summaries; only
   overdue, unfinished follow-ups in active campaigns are included. Run again
   to confirm there is one saved summary per owner per Pacific day.
7. Complete or reschedule an overdue follow-up. A refreshed preview reflects
   the changed work; the original saved daily snapshot remains available.
8. Sign out and sign in as the ordinary member to confirm access is denied.
9. Restart `sponsorships:dev`; verify saved contact changes and logo uploads.

## Reminder behavior

**Preview only: no real email is sent.** The prototype captures messages in the
Reminder inbox. An owner with no overdue items receives no message. Due today,
completed, Lost, Paid and archived-campaign motions are excluded. A revoked
admin owner keeps their historical assignment but receives no preview.

The scheduled handler checks Pacific local time and runs during the 9 a.m.
hour, with daily uniqueness preventing duplicates across 15-minute ticks.
Manual previews work at any time; development scheduling must be simulated and
does not run while the local server is stopped. The launcher enables Wrangler's
`/cdn-cgi/handler/scheduled` testing endpoint for explicit local cron checks.

## Local safety and migration tracking

The launcher accepts only `setup`, `dev`, and `reset`; it rejects all remote
flags and custom targets. It generates an isolated Wrangler configuration with
resolved local binding IDs, `remote: false`, local development login codes and
preview-only reminders. It runs with an environment allowlist and its own empty
dotenv files, so root `.dev.vars`, Cloudflare tokens, Resend keys, and bootstrap
admin tokens are not forwarded.

The authoritative schema remains `migrations/*.sql`. Setup copies those files
to an ignored staging directory and lets Wrangler track applied migrations in
`d1_migrations`. On a fresh store it applies migrations through `0013`, inserts
the historical showcase prerequisite fixtures also used by the migration
checker, then applies the remaining migrations. Existing applied migrations
are not replayed. There is no hand-maintained `schema.sql`.

For the equivalent direct commands use
`node scripts/sponsorships-local.mjs setup`, `dev`, or `reset`.

## Validation and limits

Foundation TDD evidence: the relationship and rollback tests first failed with
`no such table: sponsor_contacts`, then passed after migration `0026`. The setup
preservation and isolated-launch tests first failed because those behaviors
were absent, then passed after adding the fixture and launcher modules. The
tests use real SQLite constraints and transactional batches, with additional
acceptance against Wrangler's actual local D1/R2 runtime.

```sh
node --test tests/sponsorships-foundation.test.mjs
npm test
npm run check
npm run db:migrations:check
git diff --check
```

The prototype tracks aggregate payment amounts rather than a payment ledger,
one primary contact per business, one current follow-up and one logo per
commitment. It does not issue invoices, attach checks, publish sponsor logos or
send real reminder emails. Production deployment, migrations and delivery
configuration need a separate approved rollout.
