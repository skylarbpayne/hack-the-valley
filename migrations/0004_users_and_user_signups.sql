-- Introduce first-class users and make event signups associate a user to an event.
-- Users get their own usr_* ID space; email is stored but is not the primary ID.

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

INSERT OR IGNORE INTO users (
  id, email, name, first_name, last_name, phone, school, metadata_json, created_at, updated_at
)
SELECT
  'usr_' || lower(hex(randomblob(16))) AS id,
  lower(trim(email)) AS email,
  max(name) AS name,
  max(first_name) AS first_name,
  max(last_name) AS last_name,
  max(phone) AS phone,
  max(school) AS school,
  NULL AS metadata_json,
  min(created_at) AS created_at,
  max(updated_at) AS updated_at
FROM signups
WHERE email IS NOT NULL AND trim(email) != ''
GROUP BY lower(trim(email));

CREATE TABLE IF NOT EXISTS signups_new (
  id TEXT PRIMARY KEY,
  event_slug TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
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
  UNIQUE(event_slug, user_id)
);

INSERT OR IGNORE INTO signups_new (
  id, event_slug, user_id, name, first_name, last_name, phone, school, year, experience, notes,
  email_list_opt_in, metadata_json, mailing_list_status, mailing_list_detail, created_at, updated_at
)
SELECT
  'sgn_' || lower(hex(randomblob(16))) AS id,
  s.event_slug,
  u.id AS user_id,
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
FROM signups s
JOIN users u ON u.email = lower(trim(s.email));

DROP TABLE signups;
ALTER TABLE signups_new RENAME TO signups;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_signups_event_created_at ON signups(event_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_signups_user_id ON signups(user_id);
