-- An Access service token never becomes an HTV user or a global role.
-- Authorization is independently revocable even before the Access JWT expires.
CREATE TABLE IF NOT EXISTS hack_hours_service_identities (
  client_id TEXT PRIMARY KEY,
  target_user_id TEXT NOT NULL REFERENCES users(id),
  activated_by_user_id TEXT NOT NULL REFERENCES users(id),
  activated_at TEXT NOT NULL,
  revoked_at TEXT
);
