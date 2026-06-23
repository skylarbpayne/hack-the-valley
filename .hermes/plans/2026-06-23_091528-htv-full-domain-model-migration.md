# HTV Full Domain Model Migration Plan

> **For Hermes:** Use subagent-driven-development only after Skylar approves a specific milestone. This is a planning artifact, not approval to implement. Keep implementation evidence in a separate progress file; do not edit this plan to hide drift.

**Goal:** Incrementally migrate Hack the Valley from table-shaped route logic into a clear domain model that supports an admin dashboard for events, participation, projects, badges, content, campaigns, and audits without breaking the live public site.

**Architecture:** Build a domain/use-case boundary around the current Cloudflare Worker + D1 app before changing storage. Routes and admin UI call command/query helpers. Storage remains compatible while we introduce typed domain concepts, audit receipts, approval gates, and targeted schema additions only when the current tables cannot safely represent the domain.

**Tech Stack:** Cloudflare Workers, D1 SQLite, vanilla JS modules with JSDoc types, existing `node:test` suite, existing admin dashboard in `public/admin.html`, GitHub Actions deploy workflow.

---

## Executive recommendation

Do **not** do a giant schema rename. That would be satisfying for about five minutes and then miserable.

The right move is a staged strangler migration:

1. **Name the domain in code first.** Add modules under `functions/_lib/domain/` and route all new behavior through command/query functions.
2. **Move one live workflow at a time.** Start with Events + Participation because that is already the messiest and most user-visible area.
3. **Keep D1 tables compatible.** Existing tables (`events`, `event_instances`, `signups`, `event_participant_events`, `projects`, `badges`, etc.) remain storage implementation details until command helpers prove a better schema is needed.
4. **Make admin dashboard command-oriented.** The admin UI should say “create event instance,” “check in participant,” “award badge,” “draft campaign,” not “edit row.”
5. **Gate side effects hard.** Drafting/previewing is safe. Sending email, publishing public content, production D1 backfills, destructive migrations, and credential/provider changes require explicit approval.

## Current codebase facts this plan assumes

Verified from the repo:

- Canonical vocabulary doc exists: `docs/domain-model.md`.
- No domain boundary modules exist yet in this clean checkout; Milestone 0 must not create `functions/_lib/domain/*` or a boundary implementation.
- Main schema is in `schema.sql`; migrations currently include `0001` through `0018`, including the Demo Hours header image and address updates.
- Core domain-ish helpers currently live mostly in `functions/_lib/event-platform.js`.
- Event/signup/check-in routes include:
  - `functions/api/events/index.js`
  - `functions/api/events/[slug].js`
  - `functions/api/events/[slug]/signups/index.js`
  - `functions/api/events/[slug]/checkins/index.js`
  - `functions/api/events/[slug]/instances/[instanceId]/cockpit/index.js`
- Project routes include:
  - `functions/api/projects.js`
  - `functions/api/me/projects.js`
  - `functions/api/events/[slug]/projects/index.js`
  - `functions/api/events/[slug]/instances/[instanceId]/projects/index.js`
- Badge route exists: `functions/api/users/[id]/badges.js`.
- Blog/campaign broadcast code is not first-class domain storage yet, and this clean checkout does not include `functions/api/blog/broadcast.js` or `functions/_shared/blog-broadcast.js`.
- Current outbound communication code is limited to subscription/list-sync and event follow-up helpers such as `functions/api/subscribe.js`, `functions/_shared/mailing-list.js`, and `functions/api/events/[slug]/instances/[instanceId]/followup/index.js`.
- Admin UI currently lives in `public/admin.html`.
- Existing verification gates:
  - `npm test`
  - `npm run check`
  - `node --check` for touched JS files when needed
  - sequential migration smoke: apply `schema.sql`, then every `migrations/*.sql` to one temporary SQLite DB

## Target domain model

### 1. Person / User

A real human: auth identity, profile, private contact data, private safety profile, roles/grants, relationship to projects and event participation.

Current storage:

- `users`
- `user_sessions`
- `auth_login_codes`
- `roles`
- `emergency_contacts` currently event-instance scoped, but conceptually belongs to person safety profile with event-specific confirmation/snapshotting.

Target concepts:

```js
/**
 * @typedef {Object} Person
 * @property {string} id
 * @property {string} email
 * @property {string|null} name
 * @property {string|null} firstName
 * @property {string|null} lastName
 * @property {string|null} phone
 * @property {PersonSafetyProfile|null} safetyProfile
 * @property {RoleGrant[]} roles
 */

/**
 * @typedef {Object} PersonSafetyProfile
 * @property {string|null} emergencyContactName
 * @property {string|null} emergencyContactRelationship
 * @property {string|null} emergencyContactPhone
 * @property {string|null} confirmedAt
 */
```

Rule: emergency contact is not “signup data.” It is person/private safety data. A participation can require confirmation or snapshot it for event safety.

### 2. EventSeries

A reusable program or public page: Hack Hours, Demo Hours, Hack the Valley 2026.

Current storage:

- `events`
- public route `/events/:slug`
- event create/update admin form

Target concept:

```js
/**
 * @typedef {Object} EventSeries
 * @property {string} slug
 * @property {string} title
 * @property {string|null} description
 * @property {'draft'|'open'|'closed'|'archived'} status
 * @property {string|null} imageUrl
 * @property {string|null} pageContent
 * @property {SignupFieldConfig[]} signupFields
 * @property {RecurrenceRule|null} recurrenceRule
 */
```

Rule: EventSeries is not the roster object. It is the program/page/template.

### 3. EventInstance

One concrete occurrence/date/location/status/capacity. This is the operator object for rosters, check-in, event photos, follow-up, readiness, and attendance reporting.

Current storage:

- `event_instances`

Target concept:

```js
/**
 * @typedef {Object} EventInstance
 * @property {string} id
 * @property {string} eventSlug
 * @property {string} instanceKey
 * @property {string|null} title
 * @property {string|null} startsAt
 * @property {string|null} endsAt
 * @property {string|null} venueName
 * @property {string|null} venueAddress
 * @property {number|null} capacity
 * @property {'draft'|'open'|'closed'|'archived'} status
 */
```

Rule: operational truth lives on EventInstance, not recurrence metadata.

### 4. Participation

A person’s state in one event instance: signed up, checked in, cancelled, no-show, waitlisted, demoing/attending role, readiness blockers.

Current storage:

- `signups`
- `event_participant_events`
- view `event_participant_current_state`
- `emergency_contacts` for event-safety snapshots

Target concept:

```js
/**
 * @typedef {Object} Participation
 * @property {string} personId
 * @property {string} eventSlug
 * @property {string} eventInstanceId
 * @property {'attend'|'demo'|string|null} eventRole
 * @property {'signed_up'|'checked_in'|'cancelled'|'no_show'|'waitlisted'} state
 * @property {ReadinessBlocker[]} readinessBlockers
 * @property {string|null} signupId
 */
```

Rules:

- “Signup” is an action/input; Participation is the durable noun.
- Signed-in users should not re-enter profile/safety fields unless required data is missing or stale.
- Event-specific signup choices like `attend` vs `demo` live on Participation metadata, not Person.

### 5. Project

A durable thing a person/team is building.

Current storage:

- `projects`
- `project_members`
- legacy `submissions` as HTV 2026 raw intake

Target concept:

```js
/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} slug
 * @property {string} title
 * @property {string|null} teamName
 * @property {string|null} description
 * @property {string|null} repoUrl
 * @property {string|null} demoUrl
 * @property {ProjectMember[]} members
 */
```

Rule: project identity persists across events. An event submission references a project; it does not become the project.

### 6. EventProjectSubmission

A project shown, submitted, demoed, awarded, or showcased in an event context.

Current storage:

- `event_project_submissions`
- `event_project_awards`
- legacy `submissions`

Target concept:

```js
/**
 * @typedef {Object} EventProjectSubmission
 * @property {string} id
 * @property {string} eventSlug
 * @property {string|null} eventInstanceId
 * @property {string} projectId
 * @property {'submitted'|'accepted'|'showcased'|'winner'|'hidden'|'rejected'} status
 * @property {string} source
 */
```

Rule: showcasing/demoing a project at Demo Hours is not the same thing as globally publishing a project forever; the event context matters.

### 7. Badge / BadgeAward

A Badge is the catalog definition. A BadgeAward is a particular person receiving it with provenance.

Current storage:

- `badges`
- `user_badges`

Target concepts:

```js
/**
 * @typedef {Object} Badge
 * @property {string} id
 * @property {string} slug
 * @property {string} name
 * @property {string|null} description
 * @property {'attendance'|'demo'|'contribution'|'award'|'project'|'community'} type
 * @property {Object|null} rule
 * @property {boolean} active
 */

/**
 * @typedef {Object} BadgeAward
 * @property {string} id
 * @property {string} personId
 * @property {string} badgeSlug
 * @property {string|null} eventInstanceId
 * @property {string|null} projectId
 * @property {'admin'|'derived'|'import'} source
 * @property {string|null} awardedBy
 * @property {string} awardedAt
 */
```

Rule: derived badges should be reproducible from facts; admin-awarded badges need audit provenance.

### 8. ContentItem

Public/private editorial content: blog posts, recaps, event pages, public project writeups.

Current storage:

- event page fields on `events`
- static files under `public/blog/`
- `public/blog/posts.json`

Target concept:

```js
/**
 * @typedef {Object} ContentItem
 * @property {string} id
 * @property {string} slug
 * @property {'blog_post'|'event_page'|'recap'|'project_showcase'} kind
 * @property {'draft'|'previewed'|'published'|'archived'} status
 * @property {string} title
 * @property {string} bodyHtml
 * @property {string|null} relatedEventSlug
 * @property {string|null} relatedEventInstanceId
 * @property {string|null} relatedProjectId
 */
```

Rule: Content presents facts; it does not own people, participation, projects, or campaign delivery.

### 9. Campaign / AudienceSegment / MessageDraft / MessageDelivery

Outbound communication with audit and approval boundaries.

Current storage:

- no first-class D1 campaign tables yet
- no first-class campaign/broadcast route or helper exists in this checkout yet
- adjacent outbound surfaces are subscription/list-sync and event follow-up helpers: `functions/api/subscribe.js`, `functions/_shared/mailing-list.js`, and `functions/api/events/[slug]/instances/[instanceId]/followup/index.js`

Target concepts:

```js
/** @typedef {'draft'|'previewed'|'approved'|'scheduled'|'sent'|'cancelled'|'failed'} CampaignStatus */

/**
 * @typedef {Object} Campaign
 * @property {string} id
 * @property {'blog_broadcast'|'event_reminder'|'event_followup'|'manual'} kind
 * @property {CampaignStatus} status
 * @property {string} subject
 * @property {AudienceSegment[]} audienceSegments
 * @property {MessageDraft|null} messageDraft
 * @property {string|null} approvalId
 */

/**
 * @typedef {Object} AudienceSegment
 * @property {string} id
 * @property {string} label
 * @property {Object} criteria
 */

/**
 * @typedef {Object} MessageDraft
 * @property {string} id
 * @property {string} campaignId
 * @property {string} subject
 * @property {string} bodyHtml
 * @property {'draft'|'previewed'|'approved'} status
 */

/**
 * @typedef {Object} MessageDelivery
 * @property {string} id
 * @property {string} campaignId
 * @property {'resend'|'manual'|'test'} provider
 * @property {'created'|'scheduled'|'sent'|'failed'} status
 * @property {string|null} providerId
 * @property {string|null} error
 */
```

Rules:

- Draft/preview is safe.
- Sending/scheduling email always requires explicit approval.
- Provider delivery logs do not mutate underlying domain facts.

### 10. AdminAction / AuditEvent

A durable receipt for meaningful admin mutations.

Current storage:

- `admin_audit_events` currently role-focused
- route-specific side effects are inconsistently audited

Target concept:

```js
/**
 * @typedef {Object} AuditEvent
 * @property {string} id
 * @property {string} action
 * @property {string|null} actorUserId
 * @property {string|null} targetType
 * @property {string|null} targetId
 * @property {string|null} approvalId
 * @property {Object} metadata
 * @property {string} createdAt
 */
```

Rule: every admin command should either produce an AuditEvent or explicitly document why it is read-only/no-op.

---

## Target module layout

Create the final domain boundary as small modules, not one eternal junk drawer.

```txt
functions/_lib/domain/
  shared.js              # ids, time, json, validation, result helpers
  people.js              # Person, safety profile, roles, profile readiness
  events.js              # EventSeries, EventInstance, recurrence preview/apply helpers
  participation.js       # Participation commands, readiness, check-in/cancel/no-show
  projects.js            # Project, ProjectMember, project create/update/list commands
  submissions.js         # EventProjectSubmission, awards, showcase visibility
  badges.js              # Badge catalog, award/revoke/derive helpers
  content.js             # ContentItem drafts/previews/publish gate
  campaigns.js           # Campaign, audience, message draft, send/schedule gate
  audit.js               # AuditEvent append/query helpers
  index.js               # curated exports only
```

Keep `functions/_lib/event-platform.js` temporarily as a compatibility facade. Gradually move logic out of it.

## Command/query boundary shape

Each domain module should expose commands and queries, not table helpers.

Good:

```js
await registerParticipation(db, {
  person,
  eventSlug: "demo-hours",
  eventInstanceId: "inst_demo_hours_20260722",
  eventRole: "demo",
  source: "signed-in-event-signup"
});
```

Bad:

```js
await insertSignupRow(db, body);
await insertEmergencyContactRow(db, body);
await maybeInsertParticipantEvent(db, body);
```

Standard command result:

```js
{
  ok: true,
  entity: participation,
  auditEvent: auditReceipt,
  sideEffects: [],
  warnings: []
}
```

Standard approval-required result:

```js
{
  ok: false,
  status: "approval_required",
  action: "campaign.send",
  approvalRequired: true,
  preview: campaignPreview,
  reason: "Sending external email requires explicit approval."
}
```

## Migration milestones

### Milestone 0 — Freeze vocabulary and compatibility baseline

**Goal:** Establish the current truth and protect against drift before refactoring.

**Files:**

- Update: `docs/domain-model.md`
- Create or update: `tests/domain-model-docs.test.mjs` only if it asserts useful invariants, not useless string trivia
- Create: `.hermes/plans/<this-plan>.md`

**Tasks:**

1. Confirm current `main` includes recent Demo Hours PRs before starting implementation.
2. Update `docs/domain-model.md` with any missing concepts from this plan.
3. Add a short “storage compatibility” table: domain concept → current table(s) → migration status.
4. Run `npm test` and `npm run check`.
5. Do not modify production data.

**Acceptance:**

- Domain vocabulary doc exists and reflects Person, EventSeries, EventInstance, Participation, Project, EventProjectSubmission, Badge, BadgeAward, ContentItem, Campaign, AudienceSegment, MessageDraft, MessageDelivery, AuditEvent.
- No route behavior changes.

### Milestone 1 — Create module skeleton and shared result/audit primitives

**Goal:** Establish module boundaries without changing behavior.

**Files:**

- Create: `functions/_lib/domain/shared.js`
- Create: `functions/_lib/domain/audit.js`
- Create: `functions/_lib/domain/index.js`
- Create: `tests/domain-shared.test.mjs`
- Create: `tests/domain-audit.test.mjs`

**Implementation notes:**

`shared.js` should include:

- `parseJsonObject(value, fallback)`
- `parseJsonArray(value, fallback)`
- `stringOrNull(value)`
- `numberOrNull(value)`
- `ok(entity, extras)`
- `validationError(errors)`
- `approvalRequired(action, preview, reason)`
- `stableId(prefix, parts)`

`audit.js` should include:

- `toAuditEvent(row)`
- `buildAuditEvent({ action, actorUserId, targetType, targetId, approvalId, metadata })`
- `appendAuditEvent(db, event)`

**Schema decision:**

Do not change `admin_audit_events` yet unless it blocks generic audit events. For V0, encode extra target metadata in `metadata_json` and keep compatibility.

**Acceptance:**

- Pure unit tests pass without Cloudflare bindings.
- Existing app tests pass.
- No route imports changed yet except tests.

### Milestone 2 — Events domain module

**Goal:** Make EventSeries/EventInstance explicit and move event parsing/mapping out of route code.

**Files:**

- Create: `functions/_lib/domain/events.js`
- Modify: `functions/_lib/event-platform.js` to import/re-export event helpers or delegate internally
- Modify: `functions/api/events/index.js`
- Modify: `functions/api/events/[slug].js`
- Test: `tests/domain-events.test.mjs`
- Update existing: `tests/event-platform.test.mjs`

**Commands/queries:**

- `toEventSeries(row)`
- `toEventInstance(row)`
- `parseSignupFieldConfig(event)`
- `normalizeEventSeriesInput(input)`
- `normalizeEventInstanceInput(input, eventSeries)`
- `listEventSeries(db, options)`
- `getEventSeries(db, slug)`
- `listEventInstances(db, eventSlug, options)`
- `resolveOpenEventInstance(db, eventSlug)`
- `previewGeneratedInstances(eventSeries, options)` — dry-run only

**Important recurrence rule:**

- `events.recurrence_rule_json` is passive until `previewGeneratedInstances` / later `applyGeneratedInstances` runs.
- Generated instance keys must be deterministic, e.g. `YYYY-MM-DD-HHmm`.
- Upsert uniqueness remains `(event_slug, instance_key)`.

**Acceptance:**

- Public event page behavior unchanged.
- Admin create/update event behavior unchanged.
- Tests prove EventSeries/EventInstance mapping and signup role parsing.
- Recurrence preview has idempotent deterministic output, but no production apply path yet.

### Milestone 3 — Participation domain module

**Goal:** Replace signup-centered reasoning with Participation commands while preserving current signup/check-in UX.

**Files:**

- Create: `functions/_lib/domain/participation.js`
- Modify: `functions/api/events/[slug]/signups/index.js`
- Modify: `functions/api/events/[slug]/checkins/index.js`
- Modify: cockpit route if needed
- Modify: `functions/_lib/event-platform.js` compatibility exports
- Test: `tests/domain-participation.test.mjs`
- Update: `tests/event-platform.test.mjs`

**Commands/queries:**

- `normalizeParticipationInput(input, eventSeries, currentPerson)`
- `registerParticipation(db, { person, eventSeries, eventInstance, eventRole, safetyInput, source })`
- `checkInParticipant(db, { personId, eventInstanceId, actor })`
- `cancelParticipation(db, { personId, eventInstanceId, actor, reason })`
- `resolveParticipationReadiness(db, { personId, eventInstanceId })`
- `listParticipationRoster(db, { eventSlug, eventInstanceId })`

**Safety/profile rule:**

- If `currentPerson` exists and has current safety data, do not require contact fields.
- If `currentPerson` exists but safety data is missing, return a readiness blocker and ask only for missing safety fields.
- Anonymous/walk-up signups still require name/email/emergency contact.
- Event role choices (`attend`, `demo`) stay event-specific.

**Acceptance:**

- Signed-in signup UX remains fixed.
- Anonymous signup still validates emergency contact.
- Check-in remains idempotent.
- Participation event ledger still records `signed_up`, `checked_in`, etc.
- Local browser smoke for signed-in and anonymous event signup.

### Milestone 4 — Person safety profile extraction

**Goal:** Stop treating emergency contacts as signup-owned, while preserving event safety snapshots.

**Files:**

- Create: `functions/_lib/domain/people.js`
- Add migration only if approved: `migrations/00xx_person_safety_profile.sql`
- Modify: profile/me route(s), signup command, check-in readiness
- Test: `tests/domain-people.test.mjs`

**Schema option A — minimal/no new table:**

Keep safety data in `users.metadata_json.safety_profile` and continue snapshotting to `emergency_contacts` per event instance.

Pros: no schema churn.
Cons: weaker queryability.

**Schema option B — clean table:**

```sql
CREATE TABLE IF NOT EXISTS person_safety_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  emergency_contact_name TEXT,
  emergency_contact_relationship TEXT,
  emergency_contact_phone TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Recommendation: use **Option A first** unless we need admin querying/reporting. Move to Option B only when readiness reporting needs it.

**Acceptance:**

- Person safety profile can answer “is this person ready for event participation?”
- Event-specific emergency contact snapshot still exists for day-of safety.
- No loss of existing emergency contact behavior.

### Milestone 5 — Badges + BadgeAward provenance

**Goal:** Make badge awards explicit, reversible, and audit-ready.

**Files:**

- Create: `functions/_lib/domain/badges.js`
- Modify: `functions/api/users/[id]/badges.js`
- Modify: user state/leaderboard helpers if they read badge data directly
- Test: `tests/domain-badges.test.mjs`

**Commands/queries:**

- `listBadgeCatalog(db, options)`
- `awardBadge(db, { personId, badgeSlug, eventInstanceId, projectId, source, awardedBy })`
- `revokeBadgeAward(db, { awardId, actorUserId, reason })`
- `deriveBadgesForPerson(db, personId)` — dry-run first
- `listPersonBadges(db, personId)`

**Schema note:**

Current `user_badges` does not have `revoked_at`. Add it only when implementing revoke behavior:

```sql
ALTER TABLE user_badges ADD COLUMN revoked_at TEXT;
ALTER TABLE user_badges ADD COLUMN revoked_by TEXT;
ALTER TABLE user_badges ADD COLUMN revoke_reason TEXT;
```

Do not add revoke UI until the API and audit behavior exist.

**Acceptance:**

- Awarding existing badges still works.
- Duplicate award behavior is deterministic.
- Audit event is written for admin awards/revokes.
- Derived badge dry-run reports what would change without writing.

### Milestone 6 — Projects + EventProjectSubmission

**Goal:** Separate durable projects from event-specific submissions/showcases.

**Files:**

- Create: `functions/_lib/domain/projects.js`
- Create: `functions/_lib/domain/submissions.js`
- Modify: `functions/api/projects.js`
- Modify: `functions/api/me/projects.js`
- Modify: event project routes
- Test: `tests/domain-projects.test.mjs`
- Test: `tests/domain-event-project-submissions.test.mjs`

**Commands/queries:**

- `createProject(db, { ownerPerson, title, teamName, description, links })`
- `updateProject(db, { projectId, actorPerson, patch })`
- `addProjectMember(db, { projectId, personId/email, role })`
- `submitProjectToEvent(db, { projectId, eventSlug, eventInstanceId, source })`
- `setEventProjectSubmissionStatus(db, { submissionId, status, actor })`
- `listPublicProjects(db, filters)`
- `listEventProjectSubmissions(db, filters)`

**UX rule:**

- `/projects/` remains public showcase.
- `/me/projects/` remains participant management.
- Admin dashboard can manage event submissions/showcase status, but should not blur that with global project ownership.

**Acceptance:**

- Existing public project showcase still renders.
- Participant project creation/editing still works.
- Event-specific submission status can be managed through command helpers.
- Hidden/rejected event submissions do not accidentally hide the durable project globally unless explicitly intended.

### Milestone 7 — ContentItem drafts/previews

**Goal:** Make blog/event/recap content a domain concept without accidentally creating a CMS monster.

**Files:**

- Create: `functions/_lib/domain/content.js`
- Modify: existing static/event content surfaces only as needed; do not assume a blog broadcast route exists
- Modify: `public/admin.html` only for labels/previews, not full CMS unless approved
- Optional future migration: `content_items`
- Test: `tests/domain-content.test.mjs`

**Commands/queries:**

- `createContentDraft({ kind, title, bodyHtml, related })`
- `previewContentItem(contentItem)`
- `assertPublishApproval(action, approval)`
- `publishContentItem(...)` — stub/gated until explicitly approved

**Storage decision:**

Do not add `content_items` until we need dashboard-authored content to survive outside the static repo. For now, content boundary can wrap existing static files and event page fields.

**Acceptance:**

- Future campaign/content preview paths can use ContentItem DTO when introduced.
- No public publish/deploy path runs without approval.
- Existing static blog pages continue working.

### Milestone 8 — Campaign / email draft + approval + delivery logs

**Goal:** Turn outbound email into a first-class, auditable workflow.

**Files:**

- Create: `functions/_lib/domain/campaigns.js`
- Create/modify an approval-gated campaign draft/preview/send endpoint when introduced; no current blog broadcast route exists
- Optional migration: `campaigns`, `message_drafts`, `message_deliveries`
- Test: `tests/domain-campaigns.test.mjs`
- Update admin UI copy around draft/approval/send

**Recommended schema when ready:**

```sql
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','previewed','approved','scheduled','sent','cancelled','failed')),
  subject TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  related_content_id TEXT,
  approval_id TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_drafts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  scheduled_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Approval rule:**

Non-dry-run send/schedule must require approval provenance before:

- Resend audience discovery
- broadcast creation
- broadcast send/schedule

**Acceptance:**

- Dry-run produces campaign preview packet.
- Non-dry-run without approval returns `approval_required` and performs no external fetch to Resend.
- Approved send path is still behind a deliberate user action and can be live-smoked only with explicit recipient/audience approval.

### Milestone 9 — Admin dashboard command surface

**Goal:** Reorganize admin around workflows, not tables.

**Files:**

- Modify: `public/admin.html`
- Possibly create: `functions/api/admin/workflows.js`
- Possibly create: `functions/api/admin/audit.js`
- Test: admin HTML/content tests or browser smoke where practical

**Dashboard sections:**

1. **Events**
   - Event Series form
   - Event Instance list/create
   - recurrence preview/apply gated

2. **Participation**
   - roster
   - readiness blockers
   - check-in/no-show/cancel
   - event role filters

3. **Projects**
   - public showcase status
   - event submissions
   - project members

4. **Badges**
   - badge catalog
   - award/revoke
   - derived badge preview

5. **Content**
   - draft/preview
   - publish approval state

6. **Campaigns**
   - audience preview
   - message draft preview
   - approval/send delivery receipt

7. **Audit**
   - recent admin actions
   - filters by actor/action/entity

**Acceptance:**

- Admin UI can call command-shaped endpoints.
- Dangerous actions are visibly gated in copy and behavior.
- Read-only sections are clearly distinct from mutating actions.
- No hidden auto-send/auto-publish path.

### Milestone 10 — Route-by-route strangler migration

**Goal:** Retire direct table-shaped logic gradually.

**Order:**

1. `functions/api/events/[slug]/signups/index.js` → Participation commands
2. `functions/api/events/[slug]/checkins/index.js` → Participation commands
3. `functions/api/events/index.js` and `[slug].js` → Events queries/commands
4. cockpit route → Participation roster/readiness queries
5. project routes → Project/EventProjectSubmission commands
6. badge route → BadgeAward commands
7. campaign draft/preview/send endpoint, when introduced → Content/Campaign commands

**Rule:**

After each route migrates, tests should prove old external API behavior still works unless intentionally changed.

**Acceptance:**

- Each PR is small enough to review.
- No PR mixes unrelated domains.
- Compatibility facades shrink over time.

### Milestone 11 — Schema upgrades/backfills only after command stability

**Goal:** Add storage that the command layer has proven necessary.

Candidate migrations, in likely order:

1. `person_safety_profiles` only if `users.metadata_json` becomes insufficient.
2. `user_badges.revoked_at/revoked_by/revoke_reason` when revoke is implemented.
3. generic audit fields or new `audit_events` table if role-focused `admin_audit_events` becomes too awkward.
4. `campaigns/message_drafts/message_deliveries` when email workflow needs persisted drafts.
5. `content_items` when dashboard-authored content needs persistence independent of static files.

**Backfill rules:**

- Every migration gets a local idempotency smoke.
- Production backfills require explicit approval.
- Reads must be compatibility-aware during transition.
- Writes should go through new commands only.

### Milestone 12 — Cleanup and deletion

**Goal:** Remove legacy abstractions after all call sites move.

**Candidates:**

- shrink or split `functions/_lib/event-platform.js`
- remove duplicate validation helpers
- remove route-local JSON parsing once domain helpers own it
- delete docs-as-string tests that do not protect real behavior
- update `docs/domain-model.md` with final storage mappings

**Acceptance:**

- No behavior-only compatibility layer remains without a caller.
- Tests cover command helpers and public route behavior.
- Admin dashboard copy matches domain vocabulary.

---

## PR slicing plan

### PR A — Domain module skeleton

- Add `functions/_lib/domain/shared.js`, `audit.js`, `index.js`.
- Add pure tests.
- No route behavior changes.

### PR B — Events module

- Add `domain/events.js`.
- Delegate event mapping/signup-field parsing.
- Add recurrence preview helper, dry-run only.

### PR C — Participation module

- Add `domain/participation.js`.
- Move signup/check-in normalization and state transitions.
- Preserve signed-in signup behavior.

### PR D — People safety profile boundary

- Add `domain/people.js`.
- Decide metadata vs table for safety profile.
- Keep event safety snapshots.

### PR E — Badges domain

- Add `domain/badges.js`.
- Move award behavior.
- Add audit for admin awards.

### PR F — Projects/submissions domain

- Add `domain/projects.js` and `domain/submissions.js`.
- Move project and event submission flows.

### PR G — Content/campaign draft boundary

- Add `domain/content.js` and `domain/campaigns.js`.
- Dry-run preview remains safe.
- Non-dry-run sends return approval-required unless approval provenance exists.

### PR H — Admin dashboard workflow refactor

- Update `public/admin.html` to workflow sections.
- Add read-only workflow/audit endpoint if helpful.
- No new dangerous actions.

### PR I+ — Persisted campaign/content/audit storage

- Add new tables only after command shapes are stable.
- Backfills/production writes require approval.

---

## Testing strategy

### Unit tests

Add focused tests per domain module:

```txt
tests/domain-shared.test.mjs
tests/domain-audit.test.mjs
tests/domain-events.test.mjs
tests/domain-participation.test.mjs
tests/domain-people.test.mjs
tests/domain-badges.test.mjs
tests/domain-projects.test.mjs
tests/domain-event-project-submissions.test.mjs
tests/domain-content.test.mjs
tests/domain-campaigns.test.mjs
```

### Integration/route tests

Keep existing route behavior tests and add regressions for:

- public event page renders EventSeries + active EventInstance
- signed-in event signup uses Person profile
- anonymous signup requires contact/safety fields
- check-in is idempotent
- project submission visibility does not hide global Project accidentally
- badge award writes provenance
- campaign dry-run/preview has no external send
- non-approved campaign send returns approval-required before provider fetch

### Migration tests

For every schema PR:

```bash
rm -f /tmp/htv-schema-smoke.db
sqlite3 /tmp/htv-schema-smoke.db < schema.sql
for f in migrations/*.sql; do sqlite3 /tmp/htv-schema-smoke.db < "$f"; done
sqlite3 /tmp/htv-schema-smoke.db ".schema" >/tmp/htv-schema-smoke.schema
```

### Standard verification per PR

```bash
npm test
npm run check
node --check functions/_lib/domain/<touched>.js
```

For public UI/admin changes, also run a local browser smoke and check console errors.

For HTV deploy PRs, remember: `gh pr checks` may report no branch checks. Main deploy runs after merge.

---

## Approval gates

Allowed without additional approval:

- docs/plans
- local tests
- pure domain modules
- route refactors that preserve behavior
- dry-run previews
- draft packets
- read-only dashboard sections

Requires Skylar approval:

- merging/deploying to production
- sending/scheduling emails
- publishing public content
- production D1 writes/backfills outside normal deployed migrations
- destructive migrations
- credential/env/provider changes
- cron/automation that mutates production state

---

## Risks and mitigations

### Risk: architecture astronauting

Mitigation: every milestone must move one live workflow or remove concrete ambiguity. No generic platform work without a route/admin use case.

### Risk: route behavior changes accidentally

Mitigation: migrate one route at a time, preserve tests, use compatibility facades.

### Risk: schema churn before concept clarity

Mitigation: command modules first, schema only after command shape stabilizes.

### Risk: email side effects during tests

Mitigation: campaign tests use fake fetchers and assert non-approved sends do not call provider fetch.

### Risk: admin dashboard becomes table CRUD

Mitigation: dashboard sections mirror workflows and commands, not database tables.

### Risk: audit table becomes too role-specific

Mitigation: encode generic metadata first; add `audit_events` only when needed.

---

## Done definition for the full migration

The migration is done when:

1. Routes call domain commands/queries instead of directly owning business logic.
2. Admin dashboard surfaces workflows, not table CRUD.
3. Every mutating admin command has an audit receipt or explicit no-op/read-only reason.
4. Email sends and public publishing are approval-gated.
5. Person safety profile is conceptually separate from event participation snapshots.
6. EventSeries/EventInstance/Participation are explicit in code and tests.
7. Project and EventProjectSubmission are not conflated.
8. BadgeAward provenance is preserved.
9. Campaign/MessageDelivery can be reasoned about without reading provider-specific Resend code.
10. `functions/_lib/event-platform.js` is either a small compatibility facade or retired.
11. `docs/domain-model.md` maps each domain concept to storage and command modules.
12. `npm test`, `npm run check`, migration smoke, and relevant browser smokes pass.

## Recommended immediate next step

Start with **PR A: Domain module skeleton**.

It is low-risk, makes the codebase easier to reason about immediately, and gives every later PR a clean place to put behavior. Do not start with campaign tables or admin dashboard UI. That would build a nicer cockpit around the same conceptual mess.
