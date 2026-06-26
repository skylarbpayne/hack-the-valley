-- Send-log for blog email blasts. Guarantees at most one blast per
-- (post slug + scheduled time): the UNIQUE idempotency_key makes a retry that
-- repeats the same slug + scheduled_at collide instead of creating a second
-- Resend broadcast. broadcast_id is recorded as soon as Resend create succeeds
-- (before the send is attempted) so a send that throws can't create a duplicate
-- on retry and a failed send can be recovered against a real id.
--
-- status is a non-terminal/terminal state machine, NOT a claim that mail went
-- out. A scheduled send is only *accepted* by Resend at request time; the real
-- delivery happens later and is reconciled back from Resend's broadcast status:
--   pending     reserved, before Resend create
--   scheduled   Resend accepted the scheduled send (Resend: "scheduled")
--   sending     Resend is delivering it now (Resend: "queued")
--   sent        Resend reports it actually sent (terminal)
--   canceled    the schedule was canceled / broadcast deleted (terminal)
--   send_failed broadcast created (broadcast_id stored) but the send is not
--               confirmed. NOT terminal: the reconciler promotes it if Resend
--               shows it actually went through (lost response); one Resend still
--               shows as an unsent draft stays here for an operator to retry or
--               cancel via the stored broadcast_id.
-- last_reconciled_at records the last time the cron polled Resend for this row.
CREATE TABLE IF NOT EXISTS blog_broadcast_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  broadcast_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  last_reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blog_broadcast_sends_slug ON blog_broadcast_sends (slug);
-- The reconcile cron scans for non-terminal rows; index status to keep it cheap.
CREATE INDEX IF NOT EXISTS idx_blog_broadcast_sends_status ON blog_broadcast_sends (status);
