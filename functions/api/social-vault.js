import { getCurrentUserFromRequest, getDb, jsonResponse } from '../_lib/event-platform.js';
import { auditEventStatement, buildAuditEvent } from '../_lib/domain/audit.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
const response = (data, status = 200) => jsonResponse(data, { status, headers: { 'Cache-Control': 'private, no-store', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
const clean = (value, max) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
const idOk = id => /^sv_[a-f0-9]{32}$/.test(id || '');
const memberIdOk = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const newId = () => `sv_${crypto.randomUUID().replaceAll('-', '')}`;
const memberExists = `EXISTS (SELECT 1 FROM social_vault_members WHERE user_id = ? AND revoked_at IS NULL)`;
const ownerExists = `EXISTS (SELECT 1 FROM social_vault_members WHERE user_id = ? AND role = 'owner' AND revoked_at IS NULL)`;
const encode = bytes => btoa(String.fromCharCode(...bytes));
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function keyFor(env) {
  // Exactly 32 random bytes in base64; never use the bootstrap/admin token as a key.
  const raw = env.HTV_SOCIAL_VAULT_KEY;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw failure(503, 'Vault encryption key is not configured.');
  const bytes = decode(raw);
  if (bytes.length !== 32 || encode(bytes) !== raw) throw failure(503, 'Vault encryption key is invalid.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(env, id, login, password) {
  const key = await keyFor(env), iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({ login, password }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, key, plaintext);
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
async function decrypt(env, row) {
  const key = await keyFor(env);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(row.iv), additionalData: new TextEncoder().encode(row.id) }, key, decode(row.ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if (origin !== new URL(request.url).origin || (site && !['same-origin', 'none'].includes(site))) throw failure(403, 'Same-origin request required.');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure(415, 'JSON required.');
}
async function bodyOf(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 8192) throw failure(413, 'Request too large.');
  const text = await request.text();
  if (text.length > 8192) throw failure(413, 'Request too large.');
  try { const body = JSON.parse(text); if (body && !Array.isArray(body) && typeof body === 'object') return body; } catch {}
  throw failure(400, 'Invalid JSON object.');
}
function guard(db) {
  const id = newId();
  return [db.prepare('INSERT INTO social_vault_write_guards (id, valid) VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)').bind(id), db.prepare('DELETE FROM social_vault_write_guards WHERE id = ?').bind(id)];
}
async function write(db, statement, audit) {
  try { await db.batch([statement, ...guard(db), auditEventStatement(db, audit)]); }
  catch (error) {
    // Do not reflect driver errors (which can contain bound ciphertext or metadata).
    if (/full \(/.test(String(error))) throw failure(409, 'Vault capacity reached.');
    if (/last vault owner/i.test(String(error))) throw failure(409, 'Grant another owner before revoking the last owner.');
    if (/CHECK constraint|social_vault_write_guards/i.test(String(error))) throw failure(409, 'Vault access changed or record is stale. Refresh and retry.');
    throw failure(409, 'Vault write failed. Refresh and retry.');
  }
}
const audit = (action, actor, targetType, targetId) => buildAuditEvent({ action: `social_vault_${action}`, actorUserId: actor, targetType, targetId, scopeType: 'social_vault', scopeId: 'shared', metadata: {} });
async function roleFor(db, userId) {
  return db.prepare('SELECT role FROM social_vault_members WHERE user_id = ? AND revoked_at IS NULL').bind(userId).first();
}
async function list(db, actor, role) {
  const accounts = (await db.prepare(`SELECT id,label,revision,updated_at FROM social_vault_accounts WHERE ${memberExists} ORDER BY label`).bind(actor).all()).results || [];
  if (!(await roleFor(db, actor))) throw failure(403, 'Vault access revoked.');
  const members = role === 'owner' ? (await db.prepare(`SELECT m.user_id,u.email,m.role,m.granted_at FROM social_vault_members m JOIN users u ON u.id=m.user_id WHERE m.revoked_at IS NULL AND ${ownerExists} ORDER BY u.email`).bind(actor).all()).results || [] : undefined;
  return { ok: true, role, accounts, ...(members ? { members, capacity: 15 } : {}) };
}
export async function onRequest(context) {
  const { request, env, params = {} } = context;
  try {
    const db = getDb(env);
    // Deliberately use the magic-login session only. Admin/bootstrap roles do not grant vault access.
    const user = await getCurrentUserFromRequest(db, request);
    if (!user) throw failure(401, 'Sign in to access shared logins.');
    const actor = user.id, membership = await roleFor(db, actor);
    if (!membership) throw failure(403, 'No vault grant for this account.');
    const path = params.path || '';
    if (request.method === 'GET' && !path) return response(await list(db, actor, membership.role));
    if (!['POST', 'PUT', 'DELETE'].includes(request.method)) throw failure(405, 'Method not allowed.');
    sameOrigin(request);
    const input = request.method === 'DELETE' ? await bodyOf(request) : await bodyOf(request);
    if (path === 'members' && request.method === 'POST') {
      if (membership.role !== 'owner') throw failure(403, 'Owner required.');
      const email = clean(input.email, 254)?.toLowerCase(), role = input.role;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['owner','member'].includes(role)) throw failure(400, 'Valid email and role required.');
      const target = await db.prepare('SELECT id FROM users WHERE lower(email)=?').bind(email).first();
      if (!target) throw failure(404, 'That person must sign in once before being granted access.');
      const now = new Date().toISOString();
      await write(db, db.prepare(`INSERT INTO social_vault_members (user_id,role,granted_by_user_id,granted_at,revoked_at)
        SELECT ?,?,?,?,NULL WHERE ${ownerExists}
        ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,granted_by_user_id=excluded.granted_by_user_id,granted_at=excluded.granted_at,revoked_at=NULL`)
        .bind(target.id,role,actor,now,actor), audit('grant', actor, 'user', target.id));
      return response({ ok: true, members: (await list(db, actor, 'owner')).members });
    }
    if (path.startsWith('members/') && request.method === 'DELETE') {
      if (membership.role !== 'owner') throw failure(403, 'Owner required.');
      const target = path.slice(8);
      if (!memberIdOk(target)) throw failure(400, 'Invalid member.');
      await write(db, db.prepare(`UPDATE social_vault_members SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND ${ownerExists}`)
        .bind(new Date().toISOString(),target,actor), audit('revoke',actor,'user',target));
      return response({ ok: true, rotationWarning: 'Rotate every shared password this person could have seen; revocation cannot erase copied credentials.', members: (await list(db, actor, 'owner')).members });
    }
    if (path === 'accounts' && request.method === 'POST' || /^accounts\/sv_[a-f0-9]{32}$/.test(path) && request.method === 'PUT') {
      if (membership.role !== 'owner') throw failure(403, 'Owner required to edit credentials.');
      const label = clean(input.label, 100), login = clean(input.login, 254), password = input.password;
      if (!label || !login || typeof password !== 'string' || password.length < 1 || password.length > 2048) throw failure(400, 'Label, login and password required.');
      const id = request.method === 'POST' ? newId() : path.slice(9);
      const revision = input.revision;
      if (request.method === 'PUT' && (!Number.isSafeInteger(revision) || revision < 1)) throw failure(400, 'Current revision required.');
      const encrypted = await encrypt(env,id,login,password), now = new Date().toISOString();
      const statement = request.method === 'POST'
        ? db.prepare(`INSERT INTO social_vault_accounts(id,label,ciphertext,iv,updated_at,updated_by_user_id)
            SELECT ?,?,?,?,?,? WHERE ${ownerExists}`).bind(id,label,encrypted.ciphertext,encrypted.iv,now,actor,actor)
        : db.prepare(`UPDATE social_vault_accounts SET label=?,ciphertext=?,iv=?,revision=revision+1,updated_at=?,updated_by_user_id=?
            WHERE id=? AND revision=? AND ${ownerExists}`).bind(label,encrypted.ciphertext,encrypted.iv,now,actor,id,revision,actor);
      await write(db,statement,audit(request.method === 'POST' ? 'create':'update',actor,'social_vault_account',id));
      return response({ ok: true, id }, request.method === 'POST' ? 201 : 200);
    }
    if (/^accounts\/sv_[a-f0-9]{32}\/reveal$/.test(path) && request.method === 'POST') {
      const id = path.split('/')[1];
      const row = await db.prepare(`SELECT id,ciphertext,iv FROM social_vault_accounts WHERE id=? AND ${memberExists}`).bind(id,actor).first();
      if (!row) throw failure(404, 'Account unavailable.');
      const secret = await decrypt(env,row);
      // Recheck membership in the same atomic batch as the reveal audit, after
      // decrypting and immediately before disclosure; revoke wins if committed first.
      const gate = newId();
      try {
        await db.batch([
          db.prepare(`INSERT INTO social_vault_write_guards(id,valid) SELECT ?, CASE WHEN ${memberExists} THEN 1 ELSE 0 END`).bind(gate,actor),
          auditEventStatement(db,audit('reveal',actor,'social_vault_account',id)),
          db.prepare('DELETE FROM social_vault_write_guards WHERE id=?').bind(gate)
        ]);
      } catch { throw failure(403, 'Vault access changed.'); }
      return response({ ok: true, login: secret.login, password: secret.password });
    }
    throw failure(404, 'Unknown vault action.');
  } catch (error) {
    // Never serialize caught exceptions or secret-bearing request bodies.
    return response({ ok: false, error: error.status ? error.message : 'Vault request failed.' }, error.status || 500);
  }
}
export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
export const onRequestPut = onRequest;
export const onRequestDelete = onRequest;
