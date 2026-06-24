CREATE TABLE IF NOT EXISTS project_media_uploads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES user_sessions(id) ON DELETE SET NULL,
  event_slug TEXT REFERENCES events(slug) ON DELETE SET NULL,
  event_instance_id TEXT REFERENCES event_instances(id) ON DELETE SET NULL,
  storage_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'artifact')),
  bytes INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_media_uploads_project_created
  ON project_media_uploads(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_media_uploads_uploader_created
  ON project_media_uploads(uploaded_by_user_id, created_at DESC);
