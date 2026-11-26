CREATE TABLE palmer_auth_stage_counts (
  stage TEXT PRIMARY KEY NOT NULL CHECK(stage IN ('db_binding', 'host', 'config', 'session_header', 'missing_assertion', 'jwt_verification', 'service_claims', 'user_lookup', 'user_match', 'route_auth')),
  hits INTEGER NOT NULL DEFAULT 0 CHECK(hits BETWEEN 0 AND 2147483647)
) WITHOUT ROWID;
