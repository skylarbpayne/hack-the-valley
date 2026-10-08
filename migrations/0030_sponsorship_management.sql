-- Reusable business contacts, yearly outreach, and their optional commitments.
-- App ownership is User 1:N SponsorshipMotion; each motion has one owner.
CREATE TABLE sponsor_contacts (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_sponsor_contacts_business ON sponsor_contacts(business_name COLLATE NOCASE);

CREATE TABLE sponsorship_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  purpose TEXT,
  event_instance_id TEXT REFERENCES event_instances(id) ON DELETE SET NULL,
  archived_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_sponsorship_campaigns_year ON sponsorship_campaigns(year, archived_at);

CREATE TABLE sponsorship_motions (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES sponsor_contacts(id),
  campaign_id TEXT NOT NULL REFERENCES sponsorship_campaigns(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'not_contacted' CHECK (status IN ('not_contacted','contacted','followup','interest','negotiating','lost','committed','paid')),
  notes TEXT,
  next_action TEXT,
  follow_up_on TEXT,
  follow_up_completed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(contact_id, campaign_id)
);
CREATE INDEX idx_sponsorship_motions_campaign_status ON sponsorship_motions(campaign_id, status);
CREATE INDEX idx_sponsorship_motions_owner_followup ON sponsorship_motions(owner_user_id, follow_up_on);

CREATE TABLE sponsorships (
  id TEXT PRIMARY KEY,
  motion_id TEXT NOT NULL UNIQUE REFERENCES sponsorship_motions(id),
  contribution_type TEXT NOT NULL DEFAULT 'cash' CHECK (contribution_type IN ('cash','in_kind','both')),
  committed_cents INTEGER CHECK (committed_cents IS NULL OR (typeof(committed_cents) = 'integer' AND committed_cents >= 0)),
  received_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(received_cents) = 'integer' AND received_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  in_kind_description TEXT,
  fulfilled_at TEXT,
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('check','bank_transfer','cash','other')),
  check_reference TEXT,
  invoice_number TEXT,
  invoice_status TEXT NOT NULL DEFAULT 'not_issued' CHECK (invoice_status IN ('not_issued','issued','paid')),
  logo_storage_key TEXT,
  logo_content_type TEXT,
  logo_original_filename TEXT,
  logo_bytes INTEGER CHECK (logo_bytes IS NULL OR logo_bytes >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE sponsorship_activities (
  id TEXT PRIMARY KEY,
  motion_id TEXT NOT NULL REFERENCES sponsorship_motions(id),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sponsorship_activities_motion_time ON sponsorship_activities(motion_id, created_at DESC);

CREATE TABLE sponsorship_reminder_digests (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  local_date TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'preview' CHECK (mode = 'preview'),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT NOT NULL,
  motion_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status = 'preview'),
  created_at TEXT NOT NULL,
  UNIQUE(owner_user_id, local_date, mode)
);
CREATE INDEX idx_sponsorship_digests_date ON sponsorship_reminder_digests(local_date DESC);

CREATE TABLE sponsorship_mutation_receipts (
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_user_id, operation, idempotency_key)
);

-- D1 transactional batches must fail, not silently continue, if the expected
-- revision is missing. Insert a checked value inside the batch, then delete it.
CREATE TABLE sponsorship_write_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
