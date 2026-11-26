import { getDb, handleErrors, jsonResponse, readJson, generateId } from '../../_lib/event-platform.js';
import { auditEventStatement, buildAuditEvent } from '../../_lib/domain/audit.js';

const denied = () => Object.assign(new Error('Service identity not authorized.'), { status: 403 });
const invalid = () => Object.assign(new Error('Only an existing target and grant/revoke action are supported.'), { status: 400 });

async function serviceAccess(request, env) {
  const issuer = env.HTV_ACCESS_ISSUER;
  const audience = env.HTV_ACCESS_AUDIENCE;
  // Never use a request-supplied issuer as a key-fetch URL.
  if (typeof issuer !== 'string' || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
      typeof audience !== 'string' || !audience) throw denied();
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) throw denied();
  let claims;
  try {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    ({ payload: claims } = await jwtVerify(assertion, keys, { issuer, audience, algorithms: ['RS256'] }));
  } catch { throw denied(); }
  if (claims.type !== 'app' || claims.sub !== '' || typeof claims.common_name !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,128}\.access$/.test(claims.common_name) || claims.email ||
      !Number.isInteger(claims.iat) || claims.iat > Date.now() / 1000) throw denied();
  const db = getDb(env);
  const identity = await db.prepare(`SELECT s.target_user_id, s.activated_by_user_id, u.email
    FROM hack_hours_service_identities s JOIN users u ON u.id=s.target_user_id
    WHERE s.client_id=? AND s.revoked_at IS NULL`).bind(claims.common_name).first();
  if (!identity) throw denied();
  return { db, identity, clientId: claims.common_name };
}

async function roleReadback(db, userId) {
  return (await db.prepare(`SELECT u.email,r.role,r.scope_type,r.scope_id,r.created_at,r.revoked_at
    FROM roles r JOIN users u ON u.id=r.user_id
    WHERE r.user_id=? AND r.role='organizer' AND r.scope_type='event' AND r.scope_id='hack-hours' AND r.revoked_at IS NULL`).bind(userId).all()).results;
}

export async function onRequestGet({ request, env }) {
  return handleErrors(async () => {
    const { db, identity } = await serviceAccess(request, env);
    return jsonResponse({ ok: true, roles: await roleReadback(db, identity.target_user_id) });
  });
}

export async function onRequestPost({ request, env }) {
  return handleErrors(async () => {
    const { db, identity, clientId } = await serviceAccess(request, env);
    const input = await readJson(request);
    if (typeof input.email !== 'string' || input.email.toLowerCase() !== identity.email.toLowerCase()) throw denied();
    if (Object.keys(input).sort().join(',') !== 'action,email' ||
        !['grant', 'revoke'].includes(input.action)) throw invalid();
    const existing = await roleReadback(db, identity.target_user_id);
    if ((input.action === 'grant' && existing.length) || (input.action === 'revoke' && !existing.length))
      throw Object.assign(new Error('Role already in requested state.'), { status: 409 });
    const now = new Date().toISOString();
    // Guard the activation state inside the same transaction as the role and audit.
    // An admin revocation racing a write must abort that write.
    const guard = db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM hack_hours_service_identities WHERE client_id=? AND target_user_id=? AND revoked_at IS NULL
    ) THEN 1 ELSE json_extract('invalid', '$') END`).bind(clientId, identity.target_user_id);
    const change = input.action === 'grant'
      ? db.prepare(`INSERT INTO roles(id,user_id,role,scope_type,scope_id,granted_by_user_id,created_at,revoked_at)
          VALUES (?,?,'organizer','event','hack-hours',NULL,?,NULL)
          ON CONFLICT(user_id,role,scope_type,scope_id) DO UPDATE SET revoked_at=NULL,granted_by_user_id=excluded.granted_by_user_id`)
        .bind(generateId('role'), identity.target_user_id, now)
      : db.prepare(`UPDATE roles SET revoked_at=? WHERE user_id=? AND role='organizer' AND scope_type='event' AND scope_id='hack-hours' AND revoked_at IS NULL`)
        .bind(now, identity.target_user_id);
    await db.batch([guard, change, auditEventStatement(db, buildAuditEvent({
      action: `${input.action}_organizer`, actorUserId: null, targetType: 'user', targetId: identity.target_user_id,
      scopeType: 'event', scopeId: 'hack-hours', metadata: { source: 'hack-hours-service', clientId, activationAdminUserId: identity.activated_by_user_id, targetEmail: identity.email, role: 'organizer', executor: 'service-token' }
    }))]);
    return jsonResponse({ ok: true, action: input.action, roles: await roleReadback(db, identity.target_user_id) });
  });
}
