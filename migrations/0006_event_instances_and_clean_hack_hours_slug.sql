-- Introduce concrete event instances under reusable public event slugs.
-- Hack Hours was never promoted and has no signups, so remove the accidental
-- generated slug instead of keeping aliases or redirects.

-- Create clean Hack Hours series slug from the accidental one, then remove the old row.
INSERT OR IGNORE INTO events (
  slug, title, description, starts_at, ends_at, venue_name, venue_address, capacity, status,
  image_url, page_content, signup_fields_json, recurrence_rule_json, created_at, updated_at
)
SELECT
  'hack-hours', title, description, starts_at, ends_at, venue_name, venue_address, capacity, status,
  image_url, page_content, signup_fields_json, recurrence_rule_json, created_at, CURRENT_TIMESTAMP
FROM events
WHERE slug = 'hack-hours' || '-1';

UPDATE events
SET
  title = COALESCE((SELECT title FROM events WHERE slug = 'hack-hours' || '-1'), title),
  description = COALESCE((SELECT description FROM events WHERE slug = 'hack-hours' || '-1'), description),
  starts_at = COALESCE((SELECT starts_at FROM events WHERE slug = 'hack-hours' || '-1'), starts_at),
  ends_at = COALESCE((SELECT ends_at FROM events WHERE slug = 'hack-hours' || '-1'), ends_at),
  venue_name = COALESCE((SELECT venue_name FROM events WHERE slug = 'hack-hours' || '-1'), venue_name),
  venue_address = COALESCE((SELECT venue_address FROM events WHERE slug = 'hack-hours' || '-1'), venue_address),
  capacity = COALESCE((SELECT capacity FROM events WHERE slug = 'hack-hours' || '-1'), capacity),
  status = COALESCE((SELECT status FROM events WHERE slug = 'hack-hours' || '-1'), status),
  image_url = COALESCE((SELECT image_url FROM events WHERE slug = 'hack-hours' || '-1'), image_url),
  page_content = COALESCE((SELECT page_content FROM events WHERE slug = 'hack-hours' || '-1'), page_content),
  signup_fields_json = COALESCE((SELECT signup_fields_json FROM events WHERE slug = 'hack-hours' || '-1'), signup_fields_json),
  recurrence_rule_json = COALESCE((SELECT recurrence_rule_json FROM events WHERE slug = 'hack-hours' || '-1'), recurrence_rule_json),
  updated_at = CURRENT_TIMESTAMP
WHERE slug = 'hack-hours'
  AND EXISTS (SELECT 1 FROM events WHERE slug = 'hack-hours' || '-1');

UPDATE signups SET event_slug = 'hack-hours' WHERE event_slug = 'hack-hours' || '-1';
UPDATE event_participant_events SET event_slug = 'hack-hours' WHERE event_slug = 'hack-hours' || '-1';
DELETE FROM events WHERE slug = 'hack-hours' || '-1';

CREATE TABLE IF NOT EXISTS event_instances (
  id TEXT PRIMARY KEY,
  event_slug TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  instance_key TEXT NOT NULL,
  title TEXT,
  starts_at TEXT,
  ends_at TEXT,
  venue_name TEXT,
  venue_address TEXT,
  capacity INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'archived')),
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_slug, instance_key)
);

CREATE INDEX IF NOT EXISTS idx_event_instances_event_starts_at
  ON event_instances(event_slug, starts_at);

CREATE INDEX IF NOT EXISTS idx_event_instances_status_starts_at
  ON event_instances(status, starts_at);

-- Seed one concrete instance per existing event. Future instances can reuse the same event_slug.
INSERT OR IGNORE INTO event_instances (
  id, event_slug, instance_key, title, starts_at, ends_at, venue_name, venue_address, capacity, status,
  metadata_json, created_at, updated_at
)
SELECT
  'inst_' || replace(slug, '-', '_') || '_' || COALESCE(strftime('%Y%m%d', starts_at), 'unscheduled'),
  slug,
  COALESCE(strftime('%Y-%m-%d', starts_at), 'unscheduled'),
  title,
  starts_at,
  ends_at,
  venue_name,
  venue_address,
  capacity,
  status,
  NULL,
  created_at,
  updated_at
FROM events;

DROP VIEW IF EXISTS event_participant_current_state;

CREATE TABLE IF NOT EXISTS signups_new (
  id TEXT PRIMARY KEY,
  event_slug TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  event_instance_id TEXT REFERENCES event_instances(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  school TEXT,
  year TEXT,
  experience TEXT,
  notes TEXT,
  email_list_opt_in INTEGER NOT NULL DEFAULT 1 CHECK (email_list_opt_in IN (0, 1)),
  metadata_json TEXT,
  mailing_list_status TEXT NOT NULL DEFAULT 'pending',
  mailing_list_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_instance_id, user_id)
);

INSERT OR IGNORE INTO signups_new (
  id, event_slug, event_instance_id, user_id, name, first_name, last_name, phone, school, year,
  experience, notes, email_list_opt_in, metadata_json, mailing_list_status, mailing_list_detail,
  created_at, updated_at
)
SELECT
  s.id,
  s.event_slug,
  (
    SELECT ei.id
    FROM event_instances ei
    WHERE ei.event_slug = s.event_slug
    ORDER BY ei.starts_at IS NULL, ei.starts_at ASC, ei.created_at ASC
    LIMIT 1
  ),
  s.user_id,
  s.name,
  s.first_name,
  s.last_name,
  s.phone,
  s.school,
  s.year,
  s.experience,
  s.notes,
  s.email_list_opt_in,
  s.metadata_json,
  s.mailing_list_status,
  s.mailing_list_detail,
  s.created_at,
  s.updated_at
FROM signups s;

DROP TABLE signups;
ALTER TABLE signups_new RENAME TO signups;

CREATE INDEX IF NOT EXISTS idx_signups_event_created_at ON signups(event_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_signups_instance_created_at ON signups(event_instance_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signups_user_id ON signups(user_id);

CREATE TABLE IF NOT EXISTS event_participant_events_new (
  id TEXT PRIMARY KEY,
  event_slug TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  event_instance_id TEXT REFERENCES event_instances(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signup_id TEXT REFERENCES signups(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  data_json TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO event_participant_events_new (
  id, event_slug, event_instance_id, user_id, signup_id, event_type, actor, source, data_json, occurred_at, created_at
)
SELECT
  epe.id,
  epe.event_slug,
  COALESCE(s.event_instance_id, (
    SELECT ei.id
    FROM event_instances ei
    WHERE ei.event_slug = epe.event_slug
    ORDER BY ei.starts_at IS NULL, ei.starts_at ASC, ei.created_at ASC
    LIMIT 1
  )),
  epe.user_id,
  epe.signup_id,
  epe.event_type,
  epe.actor,
  epe.source,
  epe.data_json,
  epe.occurred_at,
  epe.created_at
FROM event_participant_events epe
LEFT JOIN signups s ON s.id = epe.signup_id;

DROP TABLE event_participant_events;
ALTER TABLE event_participant_events_new RENAME TO event_participant_events;

CREATE INDEX IF NOT EXISTS idx_event_participant_events_participant_time
  ON event_participant_events(event_slug, user_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_event_participant_events_instance_participant_time
  ON event_participant_events(event_instance_id, user_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_event_participant_events_type_time
  ON event_participant_events(event_slug, event_type, occurred_at);

CREATE VIEW IF NOT EXISTS event_participant_current_state AS
SELECT
  event_slug,
  event_instance_id,
  user_id,
  MIN(CASE WHEN event_type = 'signed_up' THEN occurred_at END) AS signed_up_at,
  MAX(CASE WHEN event_type = 'checked_in' THEN occurred_at END) AS checked_in_at,
  MAX(CASE WHEN event_type = 'checked_out' THEN occurred_at END) AS checked_out_at,
  MAX(CASE WHEN event_type = 'no_show' THEN occurred_at END) AS no_show_at,
  MAX(CASE WHEN event_type = 'cancelled' THEN occurred_at END) AS cancelled_at,
  MAX(CASE WHEN event_type = 'waitlisted' THEN occurred_at END) AS waitlisted_at,
  MAX(CASE WHEN event_type = 'waiver_confirmed' THEN occurred_at END) AS waiver_confirmed_at,
  COUNT(*) AS event_count
FROM event_participant_events
GROUP BY event_slug, event_instance_id, user_id;
