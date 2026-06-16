#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const remote = !args.has("--local");
const databaseName = process.env.HTV_D1_DATABASE_NAME || process.env.HTV_D1_DATABASE || "hack-the-valley";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseEmailList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map(normalizeEmail)
    .filter(Boolean);
}

function uniq(values) {
  return [...new Set(values)];
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function requireEmail(name, value) {
  const email = normalizeEmail(value);
  if (!EMAIL_RE.test(email)) {
    throw new Error(`${name} must be set to one valid email address.`);
  }
  return email;
}

const superAdminEmail = requireEmail("HTV_SUPER_ADMIN_EMAIL", process.env.HTV_SUPER_ADMIN_EMAIL);
const adminEmails = uniq(parseEmailList(process.env.HTV_ADMIN_EMAILS)).filter((email) => email !== superAdminEmail);
for (const email of adminEmails) {
  if (!EMAIL_RE.test(email)) throw new Error(`Invalid email in HTV_ADMIN_EMAILS: ${email}`);
}

const now = new Date().toISOString();
const targetEmails = uniq([superAdminEmail, ...adminEmails]);
const targetEmailSql = targetEmails.map(sqlString).join(", ");
const statements = [];

statements.push(`SELECT lower(email) AS email, id, name
FROM users
WHERE lower(email) IN (${targetEmailSql})
ORDER BY lower(email);`);

statements.push(`SELECT target.column1 AS missing_email
FROM (VALUES ${targetEmails.map((email) => `(${sqlString(email)})`).join(", ")}) target
LEFT JOIN users u ON lower(u.email) = target.column1
WHERE u.id IS NULL;`);

statements.push(`UPDATE roles
SET revoked_at = ${sqlString(now)}
WHERE role = 'super_admin'
  AND scope_type = 'global'
  AND scope_id = '*'
  AND revoked_at IS NULL
  AND user_id NOT IN (SELECT id FROM users WHERE lower(email) = ${sqlString(superAdminEmail)});`);

statements.push(`INSERT INTO roles (id, user_id, role, scope_type, scope_id, granted_by_user_id, created_at, revoked_at)
SELECT 'role_' || lower(hex(randomblob(16))), id, 'super_admin', 'global', '*', NULL, ${sqlString(now)}, NULL
FROM users
WHERE lower(email) = ${sqlString(superAdminEmail)}
ON CONFLICT(user_id, role, scope_type, scope_id) DO UPDATE SET revoked_at = NULL;`);

for (const email of adminEmails) {
  statements.push(`INSERT INTO roles (id, user_id, role, scope_type, scope_id, granted_by_user_id, created_at, revoked_at)
SELECT 'role_' || lower(hex(randomblob(16))), id, 'admin', 'global', '*', NULL, ${sqlString(now)}, NULL
FROM users
WHERE lower(email) = ${sqlString(email)}
ON CONFLICT(user_id, role, scope_type, scope_id) DO UPDATE SET revoked_at = NULL;`);
}

statements.push(`SELECT u.email, r.role, r.scope_type, r.scope_id, r.revoked_at
FROM roles r
JOIN users u ON u.id = r.user_id
WHERE r.role IN ('admin', 'super_admin')
ORDER BY r.role DESC, lower(u.email) ASC;`);

const sql = statements.join("\n\n");

if (!apply) {
  console.log(sql);
  console.error(`\nDry run only. This script does not create users; missing_email rows must be fixed before --apply. Target D1 database: ${databaseName}. Override with HTV_D1_DATABASE_NAME if needed. Set HTV_SUPER_ADMIN_EMAIL, HTV_ADMIN_EMAILS and rerun with --apply to write D1.`);
  process.exit(0);
}

const wranglerArgs = ["wrangler", "d1", "execute", databaseName, "--command", sql];
if (remote) wranglerArgs.splice(4, 0, "--remote");
const result = spawnSync("npx", wranglerArgs, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
