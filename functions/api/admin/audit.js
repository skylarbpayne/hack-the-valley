import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin
} from "../../_lib/event-platform.js";
import { toAuditEvent } from "../../_lib/domain/audit.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function cleanFilter(value) {
  const text = String(value || "").trim();
  return text || null;
}

function parseLimit(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

function auditFiltersFromUrl(url) {
  return {
    limit: parseLimit(url.searchParams.get("limit")),
    action: cleanFilter(url.searchParams.get("action")),
    scopeType: cleanFilter(url.searchParams.get("scope_type") || url.searchParams.get("scopeType")),
    targetUserId: cleanFilter(url.searchParams.get("target_user_id") || url.searchParams.get("targetUserId"))
  };
}

async function listAuditEvents(db, filters) {
  try {
    const result = await db.prepare(`
      SELECT
        id,
        action,
        actor_user_id,
        target_user_id,
        target_email,
        role,
        target_type,
        target_id,
        scope_type,
        scope_id,
        metadata_json,
        created_at
      FROM (
        SELECT
          id,
          action,
          actor_user_id,
          NULL AS target_user_id,
          NULL AS target_email,
          NULL AS role,
          target_type,
          target_id,
          scope_type,
          scope_id,
          metadata_json,
          created_at
        FROM audit_events
        UNION ALL
        SELECT
          legacy.id,
          legacy.action,
          legacy.actor_user_id,
          legacy.target_user_id,
          legacy.target_email,
          legacy.role,
          NULL AS target_type,
          NULL AS target_id,
          legacy.scope_type,
          legacy.scope_id,
          legacy.metadata_json,
          legacy.created_at
        FROM admin_audit_events legacy
        WHERE NOT EXISTS (SELECT 1 FROM audit_events generic_event WHERE generic_event.id = legacy.id)
      ) combined_audit_events
      WHERE (? IS NULL OR action = ?)
        AND (? IS NULL OR scope_type = ?)
        AND (? IS NULL OR target_user_id = ? OR (target_type = 'user' AND target_id = ?))
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(
      filters.action,
      filters.action,
      filters.scopeType,
      filters.scopeType,
      filters.targetUserId,
      filters.targetUserId,
      filters.targetUserId,
      filters.limit
    ).all();

    return (result.results || []).map(toAuditEvent);
  } catch (error) {
    if (!isMissingAuditEventsTableError(error)) throw error;
    return await listLegacyAdminAuditEvents(db, filters);
  }
}

async function listLegacyAdminAuditEvents(db, filters) {
  const result = await db.prepare(`
    SELECT
      id,
      action,
      actor_user_id,
      target_user_id,
      target_email,
      role,
      scope_type,
      scope_id,
      metadata_json,
      created_at
    FROM admin_audit_events
    WHERE (? IS NULL OR action = ?)
      AND (? IS NULL OR scope_type = ?)
      AND (? IS NULL OR target_user_id = ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(
    filters.action,
    filters.action,
    filters.scopeType,
    filters.scopeType,
    filters.targetUserId,
    filters.targetUserId,
    filters.limit
  ).all();

  return (result.results || []).map(toAuditEvent);
}

function isMissingAuditEventsTableError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("no such table") && message.includes("audit_events");
}

async function requireSessionAdmin(request, env) {
  const access = await requireAdmin(request, env);
  if (access.bootstrap) {
    throw Object.assign(new Error("Admin session role required"), { status: 403 });
  }
  return access;
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireSessionAdmin(context.request, context.env);
    const db = getDb(context.env);
    const filters = auditFiltersFromUrl(new URL(context.request.url));
    const events = await listAuditEvents(db, filters);
    return jsonResponse({
      ok: true,
      events,
      count: events.length,
      filters,
      maxLimit: MAX_LIMIT
    });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
