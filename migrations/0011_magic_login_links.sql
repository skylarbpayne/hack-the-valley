ALTER TABLE auth_login_codes ADD COLUMN magic_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_login_codes_magic_token
  ON auth_login_codes(magic_token_hash)
  WHERE magic_token_hash IS NOT NULL AND consumed_at IS NULL;
