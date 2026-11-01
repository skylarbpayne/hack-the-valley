-- Effective seats are the union of active vault members and active global admins.
-- Keep the existing owner row and all historical grants; only new admissions are fenced.
DROP TRIGGER social_vault_member_limit;
DROP TRIGGER social_vault_member_reactivate_limit;
CREATE TRIGGER social_vault_effective_member_limit BEFORE INSERT ON social_vault_members
WHEN NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM roles WHERE user_id=NEW.user_id AND role IN ('admin','super_admin')
  AND scope_type='global' AND scope_id='*' AND revoked_at IS NULL
) AND (SELECT COUNT(*) FROM (
  SELECT user_id FROM social_vault_members WHERE revoked_at IS NULL
  UNION SELECT user_id FROM roles WHERE role IN ('admin','super_admin') AND scope_type='global' AND scope_id='*' AND revoked_at IS NULL
)) >= 15
BEGIN SELECT RAISE(ABORT, 'Social vault is full (15 effective people)'); END;
CREATE TRIGGER social_vault_effective_member_reactivate_limit BEFORE UPDATE OF revoked_at ON social_vault_members
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
AND NOT EXISTS (SELECT 1 FROM roles WHERE user_id=NEW.user_id AND role IN ('admin','super_admin') AND scope_type='global' AND scope_id='*' AND revoked_at IS NULL)
AND (SELECT COUNT(*) FROM (
  SELECT user_id FROM social_vault_members WHERE revoked_at IS NULL
  UNION SELECT user_id FROM roles WHERE role IN ('admin','super_admin') AND scope_type='global' AND scope_id='*' AND revoked_at IS NULL
)) >= 15
BEGIN SELECT RAISE(ABORT, 'Social vault is full (15 effective people)'); END;
CREATE TRIGGER social_vault_effective_admin_limit BEFORE INSERT ON roles
WHEN NEW.role IN ('admin','super_admin') AND NEW.scope_type='global' AND NEW.scope_id='*' AND NEW.revoked_at IS NULL
AND NEW.user_id NOT IN (
  SELECT user_id FROM social_vault_members WHERE revoked_at IS NULL
  UNION SELECT user_id FROM roles WHERE role IN ('admin','super_admin') AND scope_type='global' AND scope_id='*' AND revoked_at IS NULL
) AND (SELECT COUNT(*) FROM (
  SELECT user_id FROM social_vault_members WHERE revoked_at IS NULL
  UNION SELECT user_id FROM roles WHERE role IN ('admin','super_admin') AND scope_type='global' AND scope_id='*' AND revoked_at IS NULL
)) >= 15
BEGIN SELECT RAISE(ABORT, 'Social vault is full (15 effective people)'); END;
CREATE TRIGGER social_vault_effective_admin_reactivate_limit BEFORE UPDATE OF revoked_at, role, scope_type, scope_id, user_id ON roles
WHEN NEW.role IN ('admin','super_admin') AND NEW.scope_type='global' AND NEW.scope_id='*' AND NEW.revoked_at IS NULL
AND NEW.user_id NOT IN (
  SELECT user_id FROM social_vault_members WHERE revoked_at IS NULL
  UNION SELECT user_id FROM roles WHERE id != OLD.id AND role IN ('admin','super_admin') AND scope_type='global' AND scope_id='*' AND revoked_at IS NULL
) AND (SELECT COUNT(*) FROM (
  SELECT user_id FROM social_vault_members WHERE revoked_at IS NULL
  UNION SELECT user_id FROM roles WHERE role IN ('admin','super_admin') AND scope_type='global' AND scope_id='*' AND revoked_at IS NULL
)) >= 15
BEGIN SELECT RAISE(ABORT, 'Social vault is full (15 effective people)'); END;
