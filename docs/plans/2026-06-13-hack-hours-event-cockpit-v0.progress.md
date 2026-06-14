# Hack Hours Event Cockpit V0 Progress

Plan: `docs/plans/2026-06-13-hack-hours-event-cockpit-v0.md`

## Slice 0 — Baseline and migration runway

Status: complete.

Evidence:

- Baseline `npm test && npm run check` passed before implementation: 61 tests passed; syntax check passed.
- Added `migrations/0008_hack_hours_event_cockpit_v0.sql`.
- Updated `schema.sql` with `emergency_contacts`, `event_photos`, and `roles`.
- Updated `package.json` check script to include existing check-in route and new cockpit/photo route modules.
- RED test observed: new `tests/hack-hours-cockpit.test.mjs` failed because `createEventPhotoRecord` export was missing.

## Slice 1 — Emergency contact signup contract

Status: complete.

Implemented:

- `normalizeEmergencyContactInput()`.
- `normalizeSignupInput()` now requires emergency contact name/phone and carries normalized contact data.
- `upsertEmergencyContact()` stores/updates contact per `(event_instance_id, user_id)`.
- `upsertSignup()` stores contact after resolving user/signup/concrete instance.
- Signup response includes `emergency_contact_present: true` without exposing phone.

Evidence:

- `npm test` passed after implementation.
- Local API smoke: missing emergency contact returned JSON errors for missing name and phone.
- Local API smoke: valid signup returned `201` with `event_instance_id`, `user_id`, and `emergency_contact_present: true`.

## Slice 2 — Public RSVP UI

Status: complete.

Implemented:

- Worker-rendered `/events/<slug>` RSVP form has name, email, emergency contact name, emergency contact phone, email opt-in, and `Save my spot` CTA.
- Client-rendered `public/events/index.html` detail/signup form also has emergency contact fields.
- Removed school/org, notes, waiver language from participant RSVP surface.
- Success copy confirms attendee is on the list and emergency contact is saved.

Evidence:

- Browser smoke on `http://127.0.0.1:8799/events/hack-hours`: form showed name/email/emergency-contact fields, no school/org, no layout overlap, visible Save my spot CTA.

## Slice 3 — Cockpit summary API

Status: complete.

Implemented:

- `getEventCockpit(db, eventSlug, eventInstanceId)` helper.
- `GET /api/events/:slug/instances/:instanceId/cockpit` route with organizer/admin token gate.
- Worker route matching for cockpit path.
- Summary includes signed-up, checked-in, missing emergency contact, repeat attendee, and event photo counts.
- Roster rows include user/signup/instance identity, check-in state, emergency-contact presence, attendance count, and progression labels; no school/org/notes.

Evidence:

- Local API smoke with `Authorization: Bearer local-test-token` returned cockpit summary + roster for `inst_hack_hours_20260620`.
- Unauthorized cockpit request returned `401` in tests.

## Slice 4 — Emergency-contact-aware check-in

Status: complete.

Implemented:

- Check-in blocks if emergency contact is missing with `409` and `code: "missing_emergency_contact"`.
- Admin walk-up/check-in payload supports `emergency_contact_name`, `emergency_contact_phone`, and `emergency_contact_relationship`.
- Already checked-in state returns `already_checked_in: true` instead of scary failure.

Evidence:

- Local API smoke without contact returned `{ code: "missing_emergency_contact" }`.
- Local API smoke adding contact checked the attendee in successfully.
- Repeating the same check-in returned `already_checked_in: true`.

## Slice 5 — Admin event photo API

Status: complete.

Implemented:

- `event_photos` D1 metadata model scoped to `event_instance_id` only.
- `listEventPhotos()` and `createEventPhotoRecord()` helpers.
- `GET/POST /api/events/:slug/instances/:instanceId/photos` route.
- R2 key prefix: `event-photos/:instanceId/:photoId-safeFilename`.
- Upload validation for kind/MIME, path-traversal-safe filenames, size limit, missing R2, and auth.

Evidence:

- Local API smoke uploaded `smoke.jpg` and returned storage key `event-photos/inst_hack_hours_20260620/...`.
- Tests assert no project/submission/participant linkage.

## Slice 6 — Admin cockpit UI

Status: complete.

Implemented:

- `/admin` now opens with `#event-cockpit` before settings/forms.
- Cockpit summary, roster, emergency-contact state, check-in actions, contact resolution panel, and event photo upload/list are wired.
- Event settings remain available below/secondary.

Evidence:

- Browser smoke on `http://127.0.0.1:8799/admin` after login with local test token showed cockpit as the front door, summary counts, roster rows, missing emergency contact highlighted, contact form, event photo upload, and settings below.
- Browser console had no JS errors; only Tailwind CDN production warning already existed.

## Slice 7 — UX browser acceptance and final checks

Status: complete locally.

Local setup commands used:

```bash
npx wrangler d1 migrations apply HTV_DB --local
npx wrangler d1 execute HTV_DB --local --file <temporary local seed sql>
npx wrangler dev --port 8799
```

Notes:

- Port 8788 was already occupied by an existing local Python process, so local browser acceptance used port 8799.
- `.dev.vars` is gitignored and was used only for `HTV_ADMIN_TOKEN=local-test-token` in Wrangler dev.
- No remote migrations, remote D1 writes, or production R2/D1 changes were made.

Final verification:

```bash
npm test
# 73 tests passed

npm run check
# node --check passed for Worker, helper, existing/new route modules, and scripts

python3 migration replay smoke
# migration_cockpit_v0_ok

npx wrangler deploy --dry-run
# dry-run built Worker/assets and exited successfully
```
