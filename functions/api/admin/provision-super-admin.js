import {
  generateId, getDb, handleErrors, jsonResponse, methodNotAllowed,
  normalizeEmail, readJson, requireSuperAdminAccess
} from '../../_lib/event-platform.js';
import { auditEventStatement, buildAuditEvent } from '../../_lib/domain/audit.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE = 'super_admin';
function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function emailFrom(value) {
  if (typeof value !== 'string') throw bad('A valid account email is required.');
  const email = normalizeEmail(value);
  if (email.length > 254 || !EMAIL_RE.test(email)) throw bad('A valid account email is required.');
  return email;
}
async function humanOwner(request, env) {
  const access = await requireSuperAdminAccess(request, env);
  if (access.bootstrap || !access.user?.id || access.user.service_identity || !access.user.session_id) {
    throw bad('A signed-in human global super-admin session is required.', 403);
  }
  return access;
}
async function readAccount(db, email) {
  const account = await db.prepare('SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1').bind(email).first();
  const role = account && await db.prepare(`SELECT id, user_id, role, scope_type, scope_id, granted_by_user_id, created_at
    FROM roles WHERE user_id = ? AND role = 'super_admin' AND scope_type = 'global' AND scope_id = '*' AND revoked_at IS NULL LIMIT 1`).bind(account.id).first();
  return { account: account || null, role: role || null };
}
export async function onRequestGet({ request, env }) {
  return handleErrors(async () => {
    await humanOwner(request, env);
    const email = emailFrom(new URL(request.url).searchParams.get('email'));
    return jsonResponse({ ok: true, email, ...await readAccount(getDb(env), email) });
  });
}
export async function onRequestPost({ request, env }) {
  return handleErrors(async () => {
    const access = await humanOwner(request, env);
    if (request.headers.get('Origin') !== new URL(request.url).origin) throw bad('Same-origin confirmation is required.', 403);
    const input = await readJson(request);
    const email = emailFrom(input.email);
    if (input.confirm_email !== email) throw bad('Confirm the exact account email before granting access.');
    const db = getDb(env);
    const before = await readAccount(db, email);
    if ((before.account?.id ?? null) !== (input.expected_user_id ?? null)) throw bad('Account changed since preview. Review this account again.', 409);
    if (before.account?.id === access.user.id) throw bad('You cannot provision your own role here.', 403);
    if (before.role) throw bad('This account already has global super_admin. Refresh the readback.', 409);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!before.account && (!name || name.length > 150)) throw bad('A name (up to 150 characters) is required for a new account.');
    const userId = before.account?.id || generateId('usr');
    const now = new Date().toISOString();
    const statements = [];
    if (!before.account) {
      statements.push(db.prepare('INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, email, name, now, now));
    }
    statements.push(db.prepare(`INSERT INTO roles (id, user_id, role, scope_type, scope_id, granted_by_user_id, created_at, revoked_at)
      VALUES (?, ?, 'super_admin', 'global', '*', ?, ?, NULL)
      ON CONFLICT(user_id, role, scope_type, scope_id) DO UPDATE SET
        revoked_at = NULL, granted_by_user_id = excluded.granted_by_user_id, created_at = excluded.created_at`)
      .bind(generateId('role'), userId, access.user.id, now));
    statements.push(auditEventStatement(db, buildAuditEvent({
      action: 'provision_super_admin', actorUserId: access.user.id,
      targetType: 'user', targetId: userId, scopeType: 'global', scopeId: '*',
      metadata: { source: 'admin-access-human-provision', targetEmail: email, role: ROLE, accountCreated: !before.account }
    })));
    try {
      await db.batch(statements);
    } catch (error) {
      if (/Social vault is full \(15 effective people\)/.test(String(error))) {
        throw bad('All 15 vault-access seats are occupied. Remove an effective seat before granting another super-admin.', 409);
      }
      if (/UNIQUE constraint failed/.test(String(error))) throw bad('Account changed since preview. Review this account again.', 409);
      throw error;
    }
    const readback = await readAccount(db, email);
    if (readback.account?.id !== userId || readback.role?.user_id !== userId) throw bad('Grant saved but readback failed. Refresh Access before retrying.', 500);
    return jsonResponse({ ok: true, email, account_created: !before.account, ...readback,
      vault_access: 'implicit global admin access; effective seat counted',
      verification: 'unchanged; no inbox verification or session issued' });
  });
}
export async function onRequest() { return methodNotAllowed(['GET', 'POST']); }
