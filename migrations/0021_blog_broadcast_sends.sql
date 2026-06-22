-- Send-log for blog email blasts. Guarantees at most one blast per
-- (post slug + scheduled time): the UNIQUE idempotency_key makes a retry that
-- repeats the same slug + scheduled_at collide instead of creating a second
-- Resend broadcast. broadcast_id is recorded as soon as Resend create succeeds
-- so a failed send/schedule can be recovered against a real id.
CREATE TABLE IF NOT EXISTS blog_broadcast_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  broadcast_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blog_broadcast_sends_slug ON blog_broadcast_sends (slug);
