-- Milestone 11: add a generic audit event store now that multiple non-content domains audit commands.
-- Compatible/no-backfill migration: new writes can use audit_events while legacy admin_audit_events stays readable.

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT,
  target_id TEXT,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT NOT NULL DEFAULT '*',
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at
  ON audit_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_action_created_at
  ON audit_events(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_scope_created_at
  ON audit_events(scope_type, scope_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_target_created_at
  ON audit_events(target_type, target_id, created_at DESC)
  WHERE target_type IS NOT NULL AND target_id IS NOT NULL;
