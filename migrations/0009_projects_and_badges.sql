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

INSERT OR IGNORE INTO badges (id, slug, name, description, badge_type, rule_json, active, created_at, updated_at)
VALUES
  ('bdg_first_attendance', 'first-attendance', 'First Attendance', 'Showed up to a Hack the Valley event.', 'attendance', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('bdg_repeat_attendee', 'repeat-attendee', 'Repeat Attendee', 'Came back for another Hack the Valley event.', 'attendance', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('bdg_three_time_attendee', 'three-time-attendee', '3x Attendee', 'Attended three Hack the Valley sessions.', 'attendance', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('bdg_shared_demo', 'shared-demo', 'Shared a Demo', 'Shared a project or demo with the community.', 'demo', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('bdg_helped_mentor', 'helped-mentor', 'Helped or Mentored', 'Helped another builder, mentored, or organized.', 'contribution', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

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
