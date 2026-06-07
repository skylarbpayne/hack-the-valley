-- Hack the Valley event + signup platform tables for the shared app D1 database
-- Apply with: npx wrangler d1 execute hack-the-valley-submissions --file migrations/0001_event_signups.sql --remote

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
  signup_fields_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status_starts_at ON events(status, starts_at);

CREATE TABLE IF NOT EXISTS signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_slug TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
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
  UNIQUE(event_slug, email)
);

CREATE INDEX IF NOT EXISTS idx_signups_event_created_at ON signups(event_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_signups_email ON signups(email);
