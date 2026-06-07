-- Event-sourced participant state for attendance/check-in/etc.
-- Signups remain the durable association between a user and an event.
-- Mutable operational facts (checked in, checked out, no-show, waiver-confirmed,
-- badge printed, etc.) are append-only facts here, then projected through a view.

CREATE TABLE IF NOT EXISTS event_participant_events (
  id TEXT PRIMARY KEY,
  event_slug TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_event_participant_events_type_time
  ON event_participant_events(event_slug, event_type, occurred_at);

-- Backfill existing signup associations into the event log as initial signed_up facts.
INSERT OR IGNORE INTO event_participant_events (
  id,
  event_slug,
  user_id,
  signup_id,
  event_type,
  actor,
  source,
  data_json,
  occurred_at,
  created_at
)
SELECT
  'evt_' || replace(s.id, '-', '_') || '_signed_up',
  s.event_slug,
  s.user_id,
  s.id,
  'signed_up',
  NULL,
  'migration:0005_event_participant_events',
  NULL,
  COALESCE(s.created_at, CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM signups s;

CREATE VIEW IF NOT EXISTS event_participant_current_state AS
SELECT
  event_slug,
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
GROUP BY event_slug, user_id;
