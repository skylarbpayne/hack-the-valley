CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  team_name TEXT NOT NULL,
  project_title TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  track TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  uploads_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted'
);

CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_track ON submissions(track);
CREATE INDEX IF NOT EXISTS idx_submissions_contact_email ON submissions(contact_email);

CREATE TABLE IF NOT EXISTS events (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  starts_at TEXT,
  ends_at TEXT,
  venue_name TEXT,
  venue_address TEXT,
  capacity INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'archived')),
  image_url TEXT,
  page_content TEXT,
  signup_fields_json TEXT,
  recurrence_rule_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status_starts_at ON events(status, starts_at);

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

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  school TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS signups (
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

CREATE INDEX IF NOT EXISTS idx_signups_event_created_at ON signups(event_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_signups_instance_created_at ON signups(event_instance_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signups_user_id ON signups(user_id);

CREATE TABLE IF NOT EXISTS event_participant_events (
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
