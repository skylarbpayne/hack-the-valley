-- Milestone 5: make badge awards reversible while preserving award provenance.
-- Forward-only: add nullable revoke metadata and active/revoked lookup indexes.

ALTER TABLE user_badges ADD COLUMN revoked_at TEXT;
ALTER TABLE user_badges ADD COLUMN revoked_by TEXT;
ALTER TABLE user_badges ADD COLUMN revoke_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_user_badges_user_active_awarded
  ON user_badges(user_id, awarded_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_badges_revoked_at
  ON user_badges(revoked_at)
  WHERE revoked_at IS NOT NULL;
