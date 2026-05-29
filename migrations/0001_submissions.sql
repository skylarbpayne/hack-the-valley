-- D1 schema for Hack the Valley project submissions.
-- Apply with:
--   npx wrangler d1 execute hack-the-valley-submissions --remote --file=./migrations/0001_submissions.sql

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  submitted_at TEXT NOT NULL,
  team_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  project_title TEXT NOT NULL,
  track TEXT NOT NULL,
  description TEXT NOT NULL,
  demo_url TEXT,
  repo_url TEXT,
  slides_url TEXT,
  members TEXT,
  media_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'submitted'
);

CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_track ON submissions(track);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
