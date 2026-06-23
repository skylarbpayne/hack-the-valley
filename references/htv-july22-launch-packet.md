# HTV July launch packet — Hack Hours + Demo Hours

Prepared: 2026-06-22 PDT

## Assumptions to confirm

- Next Hack Hours follows the existing cadence: Saturday, June 27, 2026, 8:00–10:00 AM PDT at Panera, 10900 Stockdale Hwy Ste 100.
- Demo Hours is Wednesday, July 22, 2026, 6:00–8:00 PM PDT at Mesh Cowork, 2020 Eye street.
- Demo Hours signup roles should be `attend` and `demo`.

## Role config for Demo Hours

```json
{
  "role_label": "I want to",
  "default_role": "attend",
  "roles": [
    {
      "value": "attend",
      "label": "Attend",
      "description": "Come watch demos, meet other builders, and hang out."
    },
    {
      "value": "demo",
      "label": "Demo something",
      "description": "Share a project, prototype, workflow, or weird experiment for a few minutes."
    }
  ]
}
```

## Production D1 launch SQL — run after role-signup code is deployed

```sql
-- Close the old open Hack Hours instance so new public signups resolve to 2026-06-27.
UPDATE event_instances
SET status = 'closed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE event_slug = 'hack-hours' AND status = 'open' AND instance_key <> '2026-06-27';

-- Keep the reusable Hack Hours event pointed at the next concrete instance.
UPDATE events
SET starts_at = '2026-06-27T15:00:00.000Z',
    ends_at = '2026-06-27T17:00:00.000Z',
    venue_name = 'Panera',
    venue_address = '10900 Stockdale Hwy Ste 100, Bakersfield, CA 93311',
    status = 'open',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE slug = 'hack-hours';

INSERT INTO event_instances (
  id, event_slug, instance_key, title, starts_at, ends_at, venue_name, venue_address, capacity, status, metadata_json, created_at, updated_at
) VALUES (
  'inst_hack_hours_20260627', 'hack-hours', '2026-06-27', 'Hack Hours',
  '2026-06-27T15:00:00.000Z', '2026-06-27T17:00:00.000Z',
  'Panera', '10900 Stockdale Hwy Ste 100, Bakersfield, CA 93311', NULL, 'open', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(event_slug, instance_key) DO UPDATE SET
  starts_at = excluded.starts_at,
  ends_at = excluded.ends_at,
  venue_name = excluded.venue_name,
  venue_address = excluded.venue_address,
  status = excluded.status,
  updated_at = excluded.updated_at;

INSERT INTO events (
  slug, title, description, starts_at, ends_at, venue_name, venue_address, capacity, status,
  image_url, page_content, signup_fields_json, recurrence_rule_json, created_at, updated_at
) VALUES (
  'demo-hours',
  'Demo Hours',
  'A low-pressure community demo night for Bakersfield builders. Come watch, or sign up to demo what you are working on.',
  '2026-07-23T01:00:00.000Z',
  '2026-07-23T03:00:00.000Z',
  'Mesh Cowork',
  '2020 Eye street',
  NULL,
  'open',
  '/assets/events/demo-hours.png',
  'Bring a project, prototype, workflow, AI experiment, app, site, robot, research thread, or half-working thing. The bar is not polish — it is showing other builders what you are trying and what you learned.\n\nYou can sign up just to attend, or sign up to demo something. We will announce recipients of the Hack Hours + Demo Hours free subscription / AI credits at this event.',
  '{"role_label":"I want to","default_role":"attend","roles":[{"value":"attend","label":"Attend","description":"Come watch demos, meet other builders, and hang out."},{"value":"demo","label":"Demo something","description":"Share a project, prototype, workflow, or weird experiment for a few minutes."}]}',
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(slug) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  starts_at = excluded.starts_at,
  ends_at = excluded.ends_at,
  venue_name = excluded.venue_name,
  venue_address = excluded.venue_address,
  capacity = excluded.capacity,
  status = excluded.status,
  image_url = excluded.image_url,
  page_content = excluded.page_content,
  signup_fields_json = excluded.signup_fields_json,
  updated_at = excluded.updated_at;

INSERT INTO event_instances (
  id, event_slug, instance_key, title, starts_at, ends_at, venue_name, venue_address, capacity, status, metadata_json, created_at, updated_at
) VALUES (
  'inst_demo_hours_20260722', 'demo-hours', '2026-07-22', 'Demo Hours',
  '2026-07-23T01:00:00.000Z', '2026-07-23T03:00:00.000Z',
  'Mesh Cowork', '2020 Eye street', NULL, 'open', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(event_slug, instance_key) DO UPDATE SET
  starts_at = excluded.starts_at,
  ends_at = excluded.ends_at,
  venue_name = excluded.venue_name,
  venue_address = excluded.venue_address,
  status = excluded.status,
  updated_at = excluded.updated_at;
```

## Email draft — do not send without final approval

Subject: Earn free AI credits: come to Hack Hours + demo by July 22

Preview: Join the next Hack Hours, then come to our first Demo Hours at Mesh Cowork.

Body:

Hey Hack the Valley community —

We’re launching a simple summer challenge:

**Attend at least 2 Hack Hours and demo something at our first Demo Hours by July 22, and you’ll be eligible for a free subscription / free AI credits.**

We’ll announce the recipients at Demo Hours.

Here’s what’s coming up:

**Hack Hours**  
Saturday, June 27, 8:00–10:00 AM  
Panera — 10900 Stockdale Hwy Ste 100

Bring whatever you’re working on: an app, school project, agent workflow, data thing, portfolio site, weird prototype, or just an idea you need help unblocking. No pitch deck. No fake startup theatre. Just builders in a room making progress.

**Demo Hours**  
Wednesday, July 22, 6:00–8:00 PM  
Mesh Cowork — 2020 Eye street

This is our first community demo night. You can sign up to attend, or sign up to demo something. “Demo” can mean polished, janky, half-working, or mostly a lesson learned — the point is to share what you’re building and make it easier for more people in the Valley to ship.

If you want the free subscription / AI credits:

1. Attend at least 2 Hack Hours.
2. Demo something at Demo Hours on July 22.
3. Make sure you sign up and check in so we can track attendance.

Links:

- Hack Hours: https://hackthevalley.org/events/hack-hours
- Demo Hours: https://hackthevalley.org/events/demo-hours

See you there,
Hack the Valley
