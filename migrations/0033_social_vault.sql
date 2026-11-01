-- Separate shared-social vault authority; provision the first owner explicitly
-- after that person has signed in (see docs/shared-social-vault.md).
CREATE TABLE social_vault_members (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  granted_by_user_id TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TRIGGER social_vault_member_limit BEFORE INSERT ON social_vault_members
WHEN NEW.revoked_at IS NULL AND (SELECT COUNT(*) FROM social_vault_members WHERE revoked_at IS NULL) >= 15
BEGIN SELECT RAISE(ABORT, 'Social vault is full (15 active people)'); END;
CREATE TRIGGER social_vault_member_reactivate_limit BEFORE UPDATE OF revoked_at ON social_vault_members
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
 AND (SELECT COUNT(*) FROM social_vault_members WHERE revoked_at IS NULL) >= 15
BEGIN SELECT RAISE(ABORT, 'Social vault is full (15 active people)'); END;
CREATE TRIGGER social_vault_last_owner BEFORE UPDATE OF revoked_at, role ON social_vault_members
WHEN OLD.role = 'owner' AND OLD.revoked_at IS NULL
 AND (NEW.revoked_at IS NOT NULL OR NEW.role != 'owner')
 AND (SELECT COUNT(*) FROM social_vault_members WHERE role = 'owner' AND revoked_at IS NULL) <= 1
BEGIN SELECT RAISE(ABORT, 'Cannot remove the last vault owner'); END;
CREATE TABLE social_vault_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL REFERENCES users(id)
);
-- A checked guard in each D1 batch makes missing/stale/unauthorized writes roll back
-- together with the audit row; never leave a successful no-op plus an audit.
CREATE TABLE social_vault_write_guards (
  id TEXT PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
