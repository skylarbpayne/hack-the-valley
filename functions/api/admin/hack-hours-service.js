import { getDb, handleErrors, jsonResponse, readJson, requireAdmin } from '../../_lib/event-platform.js';
import { auditEventStatement, buildAuditEvent } from '../../_lib/domain/audit.js';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const clientIdPattern = /^[a-zA-Z0-9_-]{8,128}\.access$/;

export async function onRequestPost({ request, env }) {
  return handleErrors(async () => {
    const access = await requireAdmin(request, env);
    if (request.headers.get('Origin') !== new URL(request.url).origin) throw invalid('Same-origin request required.', 403);
    if (access.bootstrap || !access.user?.id || access.role.scope_type !== 'global') throw invalid('Signed-in global admin required.', 403);
    const input = await readJson(request);
    const { client_id: clientId, action } = input;
    if (!clientIdPattern.test(clientId || '') || !['activate', 'revoke'].includes(action) ||
      Object.keys(input).some(k => !['client_id', 'email', 'action'].includes(k))) throw invalid('Invalid service identity request.');
    const db = getDb(env);
    const previous = await db.prepare('SELECT target_user_id, revoked_at FROM hack_hours_service_identities WHERE client_id=?').bind(clientId).first();
    let target;
    if (action === 'activate') {
      if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw invalid('Existing target email required.');
      target = await db.prepare('SELECT id,email FROM users WHERE lower(email)=?').bind(input.email.toLowerCase()).first();
      if (!target || target.id === access.user.id) throw invalid('Existing other user required.', 403);
      if (previous && previous.target_user_id !== target.id) throw invalid('Client identity cannot change targets; use a new Access token.', 409);
      if (previous && !previous.revoked_at) throw invalid('Identity already active.', 409);
    } else {
      if (input.email !== undefined || !previous || previous.revoked_at) throw invalid('Active identity required.', 409);
      target = await db.prepare('SELECT id,email FROM users WHERE id=?').bind(previous.target_user_id).first();
    }
    const now = new Date().toISOString();
    const change = action === 'activate'
      ? db.prepare(`INSERT INTO hack_hours_service_identities(client_id,target_user_id,activated_by_user_id,activated_at,revoked_at)
          VALUES (?,?,?,?,NULL) ON CONFLICT(client_id) DO UPDATE SET activated_by_user_id=excluded.activated_by_user_id,activated_at=excluded.activated_at,revoked_at=NULL`)
        .bind(clientId, target.id, access.user.id, now)
      : db.prepare('UPDATE hack_hours_service_identities SET revoked_at=? WHERE client_id=? AND revoked_at IS NULL').bind(now, clientId);
    await db.batch([change, auditEventStatement(db, buildAuditEvent({
      action: `hack_hours_service.${action}`, actorUserId: access.user.id, targetType: 'user', targetId: target.id,
      scopeType: 'event', scopeId: 'hack-hours', metadata: { clientId, targetEmail: target.email }
    }))]);
    return jsonResponse({ ok: true, action, client_id: clientId, target: { id: target.id, email: target.email }, revoked_at: action === 'revoke' ? now : null });
  });
}
