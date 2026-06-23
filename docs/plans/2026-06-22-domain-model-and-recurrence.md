# HTV Domain Model + Recurring Event Automation Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Hack the Valley's event/community platform easier to change by freezing the domain model, routing code through clearer domain helpers, and adding safe recurring event-instance generation.

**Architecture:** Preserve the existing D1 schema first. Introduce canonical vocabulary and small domain helper modules around current tables, then add recurring instance generation as an idempotent explicit operation. Avoid a risky database rename/big-bang refactor.

**Tech Stack:** Cloudflare Worker/Pages Functions, D1 SQLite, vanilla JS, Node test runner.

---

## Current-state findings

- `events.recurrence_rule_json` exists in `schema.sql`, but it is passive metadata.
- `normalizeEventInput()` stores recurrence JSON; no code generates instances from it.
- `resolveSignupEventInstance()` expects an existing open `event_instances` row.
- Public signups fail when no open concrete instance exists.
- Admin/operator surfaces already improved toward concrete event instances, but domain language is still mixed: `events` sometimes means event series, `signups` sometimes means participation, and project submission history spans both `submissions` and `event_project_submissions`.

## Non-goals

- Do not rename production tables in the first slice.
- Do not replace D1 or introduce a framework.
- Do not build a generic CRM/Eventbrite clone.
- Do not auto-send emails or auto-publish announcements.
- Do not build a generalized recurrence/rules engine before Hack Hours/Demo Hours need it.

## Final-state shape

The codebase should converge on these concepts:

- `User` / `Person`: identity and profile.
- `EventSeries`: reusable event/program such as Hack Hours or Demo Hours.
- `EventInstance`: one concrete date/time/location.
- `Participation`: user + event instance state/role/readiness.
- `Project`: durable thing being built.
- `EventProjectSubmission`: project shown/submitted/demoed in event context.
- `Content`: public pages/blogs/recaps.
- `Campaign` / `Message`: approval-gated outbound comms.

The existing tables can stay, but new code should use these names at the module/API boundary.

---

## Milestone 1: Lock domain vocabulary

**Acceptance criteria:**
- `docs/domain-model.md` exists and describes canonical concepts, table mappings, and boundary rules.
- The recurrence section explicitly says `recurrence_rule_json` is passive metadata today and not automatic generation.
- No runtime behavior changes.

### Task 1: Review domain vocabulary against current schema

**Objective:** Keep the domain model from becoming invisible tribal knowledge without adding brittle docs-as-string tests.

**Files:**
- Read: `schema.sql`
- Read: `docs/domain-model.md`

**Steps:**
1. Compare the doc's current-table mapping against `schema.sql`.
2. Confirm emergency contact is described as a user/person attribute, not a signup-owned concept.
3. Confirm recurring instances are described as an explicit generator target, not current behavior.
4. Commit docs-only changes.

---

## Milestone 2: Add domain helper seams without schema churn

**Acceptance criteria:**
- Domain helpers exist for event series/instances/participation naming.
- Existing routes still pass tests.
- No database table rename.

### Task 2: Create event domain helper module

**Objective:** Stop spreading reusable-slug vs concrete-instance logic across route files.

**Files:**
- Create: `functions/_lib/event-domain.js`
- Modify: `functions/_lib/event-platform.js`
- Test: `tests/event-platform.test.mjs`

**Suggested exports:**

```js
export function isEventSeries(row) {
  return Boolean(row?.slug);
}

export function isEventInstance(row) {
  return Boolean(row?.event_slug && row?.instance_key);
}

export function displayEventInstance(instance, series = {}) {
  return {
    id: instance.id,
    event_slug: instance.event_slug || series.slug,
    title: instance.title || series.title,
    starts_at: instance.starts_at || series.starts_at,
    ends_at: instance.ends_at || series.ends_at,
    venue_name: instance.venue_name || series.venue_name,
    venue_address: instance.venue_address || series.venue_address,
    capacity: instance.capacity ?? series.capacity ?? null,
    status: instance.status
  };
}
```

**Steps:**
1. Write tests for fallback display behavior.
2. Add the helper module.
3. Use it in one low-risk list/detail path.
4. Run `npm run check && npm test`.
5. Commit.

### Task 3: Create participation helper module

**Objective:** Introduce `Participation` as the code-level concept while keeping `signups` storage.

**Files:**
- Create: `functions/_lib/participation-domain.js`
- Modify: `functions/_lib/event-platform.js`
- Test: `tests/event-platform.test.mjs`

**Suggested exports:**

```js
export function participationRoleFromSignup(signup) {
  const metadata = safeJson(signup.metadata_json) || {};
  return signup.signup_role || metadata.signup_role || 'attend';
}

export function participationStateFromEvents(currentState) {
  if (currentState?.checked_in_at) return 'checked_in';
  if (currentState?.cancelled_at) return 'cancelled';
  if (currentState?.no_show_at) return 'no_show';
  if (currentState?.waitlisted_at) return 'waitlisted';
  if (currentState?.signed_up_at) return 'signed_up';
  return 'unknown';
}
```

**Steps:**
1. Add characterization tests around existing signup/current-state rows.
2. Add helper module.
3. Replace one duplicated role/current-state formatting call path.
4. Run `npm run check && npm test`.
5. Commit.

---

## Milestone 3: Add explicit recurring instance generation

**Acceptance criteria:**
- A recurrence helper converts a simple rule into upcoming instance candidates.
- Generation is idempotent by `(event_slug, instance_key)`.
- Manual script can dry-run and apply locally.
- No production mutation happens unless explicitly invoked.

### Task 4: Define supported recurrence rule shape

**Objective:** Keep recurrence boring and specific.

**Files:**
- Modify: `docs/domain-model.md`
- Create or modify: `tests/event-platform.test.mjs`

**Supported V0 shape:**

```json
{
  "frequency": "weekly",
  "interval": 1,
  "timezone": "America/Los_Angeles",
  "day_of_week": "saturday",
  "start_time": "08:00",
  "duration_minutes": 120,
  "starts_on": "2026-06-27",
  "generate_weeks_ahead": 8
}
```

Also allow monthly by day-of-month later, but do not implement until Demo Hours cadence needs it.

**Steps:**
1. Document the V0 recurrence shape.
2. Add tests for valid/invalid weekly rules.
3. Run targeted tests.
4. Commit.

### Task 5: Implement recurrence candidate generation

**Objective:** Generate deterministic instance candidates without touching the database yet.

**Files:**
- Create: `functions/_lib/recurrence.js`
- Test: `tests/event-platform.test.mjs`

**Suggested API:**

```js
export function generateEventInstanceCandidates(eventSeries, options = {}) {
  // returns [{ event_slug, instance_key, title, starts_at, ends_at, venue_name, venue_address, capacity, status }]
}
```

**Rules:**
- Use ISO timestamps with explicit offset or UTC conversion.
- `instance_key` must be stable and human-debuggable: `YYYY-MM-DD-HHmm`.
- Default generated instances to `draft` unless `options.defaultStatus` is provided.
- Copy venue/capacity from event series.
- Never generate past candidates unless explicitly requested.

**Steps:**
1. Write tests for weekly Hack Hours candidate generation.
2. Write tests for stable instance keys.
3. Implement generator.
4. Run `npm run check && npm test`.
5. Commit.

### Task 6: Add idempotent DB upsert for generated instances

**Objective:** Safely create missing instances without duplicates.

**Files:**
- Modify: `functions/_lib/event-platform.js` or create `functions/_lib/event-instances.js`
- Test: `tests/event-platform.test.mjs`

**Suggested API:**

```js
export async function ensureEventInstances(db, eventSeries, options = {}) {
  // returns { created: [], existing: [], candidates: [] }
}
```

**Rules:**
- Use existing `UNIQUE(event_slug, instance_key)`.
- Do not overwrite hand-edited instance fields by default.
- In dry-run mode, return candidates without writing.
- In apply mode, insert missing only.

**Steps:**
1. Add tests using fake/in-memory D1 helpers already in the suite.
2. Implement dry-run.
3. Implement apply/insert-missing.
4. Verify duplicate run creates zero additional rows.
5. Run `npm run check && npm test`.
6. Commit.

### Task 7: Add operator script

**Objective:** Give Palmer/Skylar a safe manual recurrence operation before cron.

**Files:**
- Create: `scripts/generate-event-instances.mjs`
- Modify: `package.json`
- Test: `tests/event-platform.test.mjs` or script smoke test if existing harness supports it

**CLI shape:**

```bash
node scripts/generate-event-instances.mjs --event hack-hours --dry-run
node scripts/generate-event-instances.mjs --event hack-hours --apply
```

**Rules:**
- Default to dry-run.
- Print created/existing/candidate counts.
- Require `--apply` for writes.
- For remote D1, require explicit Wrangler command/env setup; do not hide production mutation behind a convenience default.

**Steps:**
1. Add package script: `events:instances:generate`.
2. Implement dry-run output.
3. Implement apply only after explicit flag.
4. Smoke locally.
5. Run `npm run check && npm test`.
6. Commit.

---

## Milestone 4: Admin UX for recurrence

**Acceptance criteria:**
- Admin can see recurrence metadata and upcoming/missing generated instances.
- Admin action is explicit: preview first, create after confirmation.
- Production mutation remains behind admin auth.

### Task 8: Add admin preview API

**Files:**
- Create: `functions/api/events/[slug]/instances/preview.js` or route via Worker router if Pages path routing needs it
- Modify: `worker.js`
- Test: `tests/event-platform.test.mjs`

**Rules:**
- Admin-only.
- Returns candidates and which already exist.
- No writes.

### Task 9: Add admin apply API

**Files:**
- Create: `functions/api/events/[slug]/instances/generate.js`
- Modify: `worker.js`
- Test: `tests/event-platform.test.mjs`

**Rules:**
- Admin-only.
- Writes missing instances only.
- Requires explicit POST.
- Returns created/existing/candidates.

### Task 10: Add admin UI controls

**Files:**
- Modify: `public/admin.html`
- Test: `tests/event-platform.test.mjs`

**Rules:**
- Show recurrence rule JSON on event editor.
- Add “Preview generated instances”.
- Add “Create missing instances” only after preview.
- Show concrete rows, not hidden dropdown magic.

---

## Milestone 5: Participation model cleanup

**Acceptance criteria:**
- Public/admin APIs can expose `participation` wording without breaking existing `signup` consumers.
- Role/state/readiness is formatted from one helper.
- Future routes can stop treating signup as the central concept.

### Task 11: Add participation projection to signup responses

**Files:**
- Modify: `functions/api/events/[slug]/signups/index.js`
- Modify: `functions/_lib/event-platform.js`
- Test: `tests/event-platform.test.mjs`

**Compatibility rule:** preserve existing response fields while adding a nested `participation` object.

### Task 12: Add participation-focused docs/comments around current tables

**Files:**
- Modify: `schema.sql`
- Modify: latest migration docs if needed

**Rule:** comments/docs only unless a migration is truly required.

---

## Milestone 6: Content and campaign boundaries

**Acceptance criteria:**
- A short doc explains where blogs/emails belong and where they do not.
- Email follow-up work is modeled as campaigns/drafts/deliveries, not event facts.

### Task 13: Add content/comms domain notes

**Files:**
- Modify: `docs/domain-model.md`
- Optionally create: `docs/comms-model.md`

**Rules:**
- Blog/content references facts; it does not own them.
- Campaigns target derived segments.
- Sends are approval-gated.

---

## Verification gates

Every implementation PR must include:

- `npm run check`
- `npm test`
- for recurrence: proof that running generation twice is idempotent
- for admin UI: screenshot evidence if UI changes
- for production D1 changes: dry-run/read-only query first, explicit Skylar approval before apply

## Rollout recommendation

Ship this as multiple PRs:

1. Docs + domain tests.
2. Domain helper seams.
3. Recurrence generator + script.
4. Admin preview/apply UI.
5. Participation projection cleanup.
6. Content/campaign boundary cleanup.

Do **not** bundle all of this into the Demo Hours launch PR. That would be how we make the mess worse while pretending to clean it.
