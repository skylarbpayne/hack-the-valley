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

CREATE TABLE IF NOT EXISTS auth_login_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  magic_token_hash TEXT,
  purpose TEXT NOT NULL DEFAULT 'login',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_auth_login_codes_lookup
  ON auth_login_codes(user_id, code_hash, expires_at)
  WHERE consumed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_login_codes_magic_token
  ON auth_login_codes(magic_token_hash)
  WHERE magic_token_hash IS NOT NULL AND consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_login_codes_email_created
  ON auth_login_codes(email, created_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  ip_hint TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
  ON user_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;

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

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id TEXT PRIMARY KEY,
  event_instance_id TEXT NOT NULL REFERENCES event_instances(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signup_id TEXT REFERENCES signups(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  relationship TEXT,
  phone TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'signup',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_instance_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_emergency_contacts_instance_user
  ON emergency_contacts(event_instance_id, user_id);

CREATE TABLE IF NOT EXISTS event_photos (
  id TEXT PRIMARY KEY,
  event_slug TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  event_instance_id TEXT NOT NULL REFERENCES event_instances(id) ON DELETE CASCADE,
  uploaded_by TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'approved', 'hidden', 'dismissed')),
  storage_key TEXT NOT NULL UNIQUE,
  public_url TEXT,
  original_filename TEXT,
  content_type TEXT,
  bytes INTEGER,
  caption TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_photos_instance_created_at
  ON event_photos(event_instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_photos_status
  ON event_photos(status, created_at DESC);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'event', 'event_instance', 'organization')),
  scope_id TEXT NOT NULL DEFAULT '*',
  granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(user_id, role, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_roles_user_active
  ON roles(user_id, role, scope_type, scope_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  team_name TEXT,
  description TEXT,
  repo_url TEXT,
  demo_url TEXT,
  tracks_json TEXT,
  canonical_submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_canonical_submission ON projects(canonical_submission_id);

CREATE TABLE IF NOT EXISTS project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  source TEXT NOT NULL DEFAULT 'submission',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, user_id),
  UNIQUE(project_id, email)
);

CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

CREATE TABLE IF NOT EXISTS event_project_submissions (
  id TEXT PRIMARY KEY,
  event_slug TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  event_instance_id TEXT REFERENCES event_instances(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'showcased', 'winner', 'hidden', 'rejected')),
  source TEXT NOT NULL DEFAULT 'submission_portal',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_slug, event_instance_id, project_id, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_event_project_submissions_event
  ON event_project_submissions(event_slug, event_instance_id, status);
CREATE INDEX IF NOT EXISTS idx_event_project_submissions_project
  ON event_project_submissions(project_id);

CREATE TABLE IF NOT EXISTS badges (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  badge_type TEXT NOT NULL DEFAULT 'community',
  rule_json TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_badges_slug ON badges(slug);
CREATE INDEX IF NOT EXISTS idx_badges_type_active ON badges(badge_type, active);

CREATE TABLE IF NOT EXISTS user_badges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  event_instance_id TEXT REFERENCES event_instances(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'admin',
  awarded_by TEXT,
  awarded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, badge_id, event_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user_awarded
  ON user_badges(user_id, awarded_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_badges_event
  ON user_badges(event_instance_id, badge_id);

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
