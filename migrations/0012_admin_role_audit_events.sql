CREATE TABLE IF NOT EXISTS admin_audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_email TEXT,
  role TEXT,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT NOT NULL DEFAULT '*',
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created_at
  ON admin_audit_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_target
  ON admin_audit_events(target_user_id, created_at DESC);
