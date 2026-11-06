import {
  generateId,
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  normalizeEmail,
  readJson,
  requireAdmin
} from "../../_lib/event-platform.js";
import { auditEventStatement, buildAuditEvent } from "../../_lib/domain/audit.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MANAGED_ROLES = new Set(["admin", "organizer"]);

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
    WHERE r.role IN ('admin', 'super_admin', 'organizer')
      AND r.revoked_at IS NULL
    ORDER BY CASE r.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.email) ASC
  `).all();
  return result.results || [];
}

async function requireExistingUser(db, email) {
  const existing = await db.prepare("SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1").bind(email).first();
  if (!existing) {
    throw Object.assign(new Error("No user exists for that email. Ask them to sign in once before granting a role."), { status: 404 });
  }
  return existing;
}

function roleAuditStatement(db, { action, targetUserId, targetEmail, role, actorUserId }) {
  return auditEventStatement(db, buildAuditEvent({
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

async function grantRole(db, email, role, access) {
  const user = await requireExistingUser(db, email);
  const now = new Date().toISOString();
  try {
    await db.batch([db.prepare(`
    INSERT INTO roles (id, user_id, role, scope_type, scope_id, granted_by_user_id, created_at, revoked_at)
    VALUES (?, ?, ?, 'global', '*', ?, ?, NULL)
    ON CONFLICT(user_id, role, scope_type, scope_id) DO UPDATE SET
      granted_by_user_id = excluded.granted_by_user_id,
      revoked_at = NULL
  `).bind(generateId("role"), user.id, role, actorId(access), now),
    roleAuditStatement(db, { action: `grant_${role}`, targetUserId: user.id, targetEmail: email, role, actorUserId: actorId(access) })]);
  } catch (error) {
    if (role === "admin" && /Social vault is full \(15 effective people\)/.test(String(error))) {
      throw Object.assign(new Error("All 15 vault-access seats are occupied. Remove an effective seat before granting another admin."), { status: 409 });
    }
    throw error;
  }
  return user;
}

async function revokeRole(db, email, role, access) {
  const user = await db.prepare("SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1").bind(email).first();
  if (!user) throw Object.assign(new Error("No user exists for that email."), { status: 404 });
  const now = new Date().toISOString();
  await db.batch([db.prepare(`
    UPDATE roles
    SET revoked_at = ?
    WHERE user_id = ?
      AND role = ?
      AND scope_type = 'global'
      AND scope_id = '*'
      AND revoked_at IS NULL
  `).bind(now, user.id, role),
    roleAuditStatement(db, { action: `revoke_${role}`, targetUserId: user.id, targetEmail: email, role, actorUserId: actorId(access) })]);
  return user;
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const access = await requireAdmin(context.request, context.env);
    if (access.bootstrap || !access.user?.id) throw Object.assign(new Error("A signed-in admin session is required."), { status: 403 });
    const db = getDb(context.env);
    const roles = await listAdminRoles(db);
    return jsonResponse({ ok: true, bootstrap: Boolean(access.bootstrap), roles, count: roles.length });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = await requireAdmin(context.request, context.env);
    if (access.bootstrap || !access.user?.id) throw Object.assign(new Error("A signed-in admin session is required."), { status: 403 });
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const email = assertAdminEmail(input.email);
    const action = String(input.action || "grant").trim().toLowerCase();
    const role = input.role === undefined ? "admin" : input.role;
    if (!MANAGED_ROLES.has(role) || (input.scope_type && input.scope_type !== "global") || (input.scope_id && input.scope_id !== "*"))
      throw Object.assign(new Error("Only global admin and organizer grants are supported. Seed super_admin separately."), { status: 400 });
    if (role === "admin" && access.role.role !== "super_admin")
      throw Object.assign(new Error("Only a signed-in global super-admin may change admin grants."), { status: 403 });
    let user;
    if (action === "grant") {
      user = await grantRole(db, email, role, access);
    } else if (action === "revoke") {
      user = await revokeRole(db, email, role, access);
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
