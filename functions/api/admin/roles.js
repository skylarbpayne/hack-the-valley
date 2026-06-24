import {
  generateId,
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  normalizeEmail,
  readJson,
  requireSuperAdminAccess
} from "../../_lib/event-platform.js";
import { appendAuditEvent, buildAuditEvent } from "../../_lib/domain/audit.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMIN_ROLE = "admin";

function assertAdminEmail(value) {
  const email = normalizeEmail(value);
  if (!EMAIL_RE.test(email)) {
    throw Object.assign(new Error("A valid email is required."), { status: 400 });
  }
  return email;
}

function actorId(access) {
  return access?.user?.id || null;
}

async function listAdminRoles(db) {
  const result = await db.prepare(`
    SELECT
      r.id,
      r.role,
      r.scope_type,
      r.scope_id,
      r.created_at,
      r.revoked_at,
      r.granted_by_user_id,
      u.id AS user_id,
      u.email,
      u.name
    FROM roles r
    JOIN users u ON u.id = r.user_id
    WHERE r.role IN ('admin', 'super_admin')
      AND r.revoked_at IS NULL
    ORDER BY CASE r.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.email) ASC
  `).all();
  return result.results || [];
}

async function requireExistingUser(db, email) {
  const existing = await db.prepare("SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1").bind(email).first();
  if (!existing) {
    throw Object.assign(new Error("No user exists for that email. Ask them to sign in once before granting admin."), { status: 404 });
  }
  return existing;
}

async function auditRoleChange(db, { action, targetUserId, targetEmail, role, actorUserId }) {
  await appendAuditEvent(db, buildAuditEvent({
    action,
    actorUserId,
    targetType: "user",
    targetId: targetUserId,
    scopeType: "global",
    scopeId: "*",
    metadata: {
      source: "admin-role-manager",
      targetEmail,
      role
    }
  }));
}

async function grantAdmin(db, email, access) {
  const user = await requireExistingUser(db, email);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO roles (id, user_id, role, scope_type, scope_id, granted_by_user_id, created_at, revoked_at)
    VALUES (?, ?, ?, 'global', '*', ?, ?, NULL)
    ON CONFLICT(user_id, role, scope_type, scope_id) DO UPDATE SET
      granted_by_user_id = excluded.granted_by_user_id,
      revoked_at = NULL
  `).bind(generateId("role"), user.id, ADMIN_ROLE, actorId(access), now).run();
  await auditRoleChange(db, { action: "grant_admin", targetUserId: user.id, targetEmail: email, role: ADMIN_ROLE, actorUserId: actorId(access) });
  return user;
}

async function revokeAdmin(db, email, access) {
  const user = await db.prepare("SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1").bind(email).first();
  if (!user) throw Object.assign(new Error("No user exists for that email."), { status: 404 });
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE roles
    SET revoked_at = ?
    WHERE user_id = ?
      AND role = 'admin'
      AND scope_type = 'global'
      AND scope_id = '*'
      AND revoked_at IS NULL
  `).bind(now, user.id).run();
  await auditRoleChange(db, { action: "revoke_admin", targetUserId: user.id, targetEmail: email, role: ADMIN_ROLE, actorUserId: actorId(access) });
  return user;
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const access = await requireSuperAdminAccess(context.request, context.env);
    const db = getDb(context.env);
    const roles = await listAdminRoles(db);
    return jsonResponse({ ok: true, bootstrap: Boolean(access.bootstrap), roles, count: roles.length });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = await requireSuperAdminAccess(context.request, context.env);
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const email = assertAdminEmail(input.email);
    const action = String(input.action || "grant").trim().toLowerCase();
    if (input.role && input.role !== ADMIN_ROLE) {
      throw Object.assign(new Error("This endpoint only manages admin grants. Seed super_admin separately."), { status: 400 });
    }
    let user;
    if (action === "grant") {
      user = await grantAdmin(db, email, access);
    } else if (action === "revoke") {
      user = await revokeAdmin(db, email, access);
    } else {
      throw Object.assign(new Error("action must be grant or revoke."), { status: 400 });
    }
    const roles = await listAdminRoles(db);
    return jsonResponse({ ok: true, action, user, roles, count: roles.length });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
