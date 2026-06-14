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
