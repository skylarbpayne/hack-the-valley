CREATE TABLE IF NOT EXISTS event_project_awards (
  id TEXT PRIMARY KEY,
  event_slug TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  award_slug TEXT NOT NULL,
  award_title TEXT NOT NULL,
  award_rank INTEGER NOT NULL DEFAULT 1,
  prize_amount_cents INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_slug, project_id, award_slug)
);

CREATE INDEX IF NOT EXISTS idx_event_project_awards_event
  ON event_project_awards(event_slug, award_rank, award_slug);

CREATE INDEX IF NOT EXISTS idx_event_project_awards_project
  ON event_project_awards(project_id);
