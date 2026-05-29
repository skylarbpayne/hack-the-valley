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
