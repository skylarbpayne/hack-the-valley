# Hack the Valley Domain Model

Last updated: 2026-06-22

This document is the canonical vocabulary for the Hack the Valley community platform. When product work feels messy, start here before adding another field, table, or route.

## Product frame

Hack the Valley is not trying to become a generic CRM or Eventbrite clone. The core loop is:

1. Plan a concrete community gathering.
2. Publish the page and collect intent.
3. Know who is coming, who showed up, what they did, and what they need next.
4. Capture projects/demos/media/outcomes.
5. Send the right follow-up.
6. Use that history to make the next gathering better.

Everything in the model should support that loop.

## Core objects

### Person / User

A real human in the community.

Current table: `users`

Owns:
- identity: email, name, phone, school/profile fields
- emergency contact details / private safety profile
- auth/session relationship
- global community history
- roles/admin grants through `roles`
- badges through `user_badges`
- project membership through `project_members`

Rules:
- Email is an attribute, not the primary identity.
- Emergency contact is an attribute of the person/user; an event may require confirming or snapshotting it for operational readiness, but it is not conceptually owned by the signup.
- A person can attend many event instances.
- A person can belong to many projects.
- Admin privilege is a scoped role grant, not a magic email check.

### Event Series

A reusable event concept or program: `Hack Hours`, `Demo Hours`, `Hack the Valley 2026`.

Current table: `events`

Owns:
- stable slug and public URL namespace
- default title/description/page content
- default venue/capacity/signup configuration
- optional recurrence rule
- default lifecycle policy for instances

Rules:
- `events` should not be treated as one concrete date when the event repeats.
- A recurring public page such as `/events/hack-hours` should resolve to a concrete upcoming/open instance for signup.
- Event-series data is default/config data. Instance-specific facts belong on `event_instances`.

### Event Instance

One concrete occurrence of an event series: `2026-06-27 Hack Hours`, `2026-07-22 Demo Hours`.

Current table: `event_instances`

Owns:
- date/time/location/capacity/status for one occurrence
- operational roster scope
- check-in scope
- photos/media scope
- follow-up/cockpit scope

Rules:
- Signups, check-ins, event photos, and instance project submissions should all scope to `event_instance_id` when the event has instances.
- Reusable slugs are routing conveniences, not the operational source of truth.
- Admin UI should expose concrete instances as first-class rows.

### Participation

A person's relationship with one event instance.

Current tables:
- `signups` stores the durable signup row.
- `event_participant_events` stores append-only participation facts.
- `event_participant_current_state` is the current-state projection.

Owns:
- intent/state: signed up, checked in, no-show, cancelled, waitlisted
- participant role: attendee, demo presenter, mentor, volunteer, organizer, etc.
- emergency/readiness linkage
- attendance history

Rules:
- “Signup” is an action/input. The domain concept is participation.
- Current state should be derived from append-only events where possible.
- Participant role should not be scattered across arbitrary metadata conventions. Until there is a dedicated column, it must have a single helper/API contract.

### Project

A durable thing a person/team is building.

Current tables:
- `projects`
- `project_members`
- legacy/import source: `submissions`

Owns:
- title, description, repo/demo/media links
- team/members
- public showcase identity
- canonical migration link to older submissions when needed

Rules:
- A project can exist outside any one event.
- A project can be submitted/demoed at multiple event instances over time.
- Public project pages must not leak contact/private payload data.

### Event Project Submission

A project's relationship with a specific event series/instance: submitted, demoed, showcased, hidden, winner, etc.

Current table: `event_project_submissions`

Owns:
- event context for a project
- submission/demo status
- judging/showcase visibility
- link back to legacy `submissions` when needed

Rules:
- This is not the project itself.
- Demo Hours should use this layer to represent “demoed at Jul 22 Demo Hours.”
- Awards attach to project/event context, not raw signup rows.

### Badge / Community State

A durable community achievement or progression signal.

Current tables:
- `badges`
- `user_badges`

Owns:
- attendance/progression badges
- project/demo badges
- awards and contribution markers

Rules:
- Badges should encode useful community state, not just decoration.
- Start with explicit code/data rules. Do not build a generalized rules engine until repeated pain proves it.

### Content

Editorial/public pages: event pages, blog posts, recap pages, announcements.

Current state:
- event pages mostly come from `events.page_content` and frontend/static assets
- blog-related work is adjacent and should not be mixed into participation tables

Rules:
- Content is presentation/publication.
- Content may reference events, projects, and people, but should not become the source of truth for attendance or submissions.

### Campaign / Message / Delivery

Outbound communication: email drafts, announcement campaigns, segments, send history, delivery state.

Current state:
- mailing list and Resend sync live outside the core event model
- event follow-up drafts exist in cockpit/follow-up helpers

Rules:
- Email is not a core domain object; it is a communication artifact.
- Campaigns target segments derived from people/participation/project facts.
- Sending remains approval-gated.
- Delivery logs should not mutate the underlying event facts.

## Current recurrence truth

`events.recurrence_rule_json` exists, but today it is passive metadata. There is no automatic generator that creates `event_instances` from it.

Current behavior:
- event creation/update stores `recurrence_rule_json`
- signup/check-in paths resolve against existing open `event_instances`
- if no open instance exists, public signup fails with “No open instance is available for this event”

Therefore recurring events currently require manual instance creation/open/close.

## Target recurrence behavior

The platform should support an idempotent instance generator:

1. Read active/open event series with `recurrence_rule_json`.
2. Generate concrete `event_instances` for the next N occurrences.
3. Use stable `instance_key` values such as `2026-07-22-1800`.
4. Never duplicate an existing `(event_slug, instance_key)`.
5. Copy default venue/capacity/title from the event series unless the instance overrides them.
6. Optionally auto-close old instances after `ends_at`.
7. Keep human approval for public announcement/email sends.

First implementation should be boring:
- a script and admin button/manual endpoint first
- scheduled automation later
- no silent production mutation before review

## Boundary rules

- If it answers “what gathering is this?” it belongs to Event Series / Event Instance.
- If it answers “who is this human?” it belongs to User/Person.
- If it answers “what is this person’s state at this instance?” it belongs to Participation.
- If it answers “what did this team build?” it belongs to Project.
- If it answers “where was this project shown/submitted?” it belongs to Event Project Submission.
- If it answers “what should we say/send?” it belongs to Campaign/Message.
- If it answers “what appears publicly?” it belongs to Content or a safe public projection.

## Refactor posture

Do not big-bang rename the database. The safer sequence is:

1. Freeze vocabulary in docs and tests.
2. Add domain helper modules that expose the right concepts while preserving existing tables.
3. Move routes to the helpers one slice at a time.
4. Add migrations only when a concept cannot be safely represented with current tables.
5. Keep public routes/API compatibility unless intentionally changed.
