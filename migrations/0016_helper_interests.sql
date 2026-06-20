CREATE TABLE IF NOT EXISTS helper_interests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  contact TEXT,
  role_interest TEXT NOT NULL CHECK (role_interest IN ('volunteer', 'mentor', 'judge', 'workshop_host', 'sponsor', 'organizer', 'other')),
  availability TEXT,
  event_interest TEXT,
  skills TEXT,
  notes TEXT,
  consent_contact INTEGER NOT NULL DEFAULT 0 CHECK (consent_contact IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'helper-interest-form',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_helper_interests_created_at ON helper_interests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_helper_interests_role_status ON helper_interests(role_interest, status);
CREATE INDEX IF NOT EXISTS idx_helper_interests_user_id ON helper_interests(user_id);
