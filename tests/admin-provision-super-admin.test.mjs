import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';
import { sponsorHash } from '../functions/_lib/domain/sponsorships.js';
import { readFileSync } from 'node:fs';

const origin = 'http://localhost:8788';
async function fixture(t) {
  const { db, sqlite, close } = await createSponsorshipDb();
  t.after(close);
  for (const [name, id] of Object.entries(DEMO_USERS)) {
    await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
      .bind(`provision-${name}`, id, await sponsorHash(`provision-${name}`), '2026-01-01', '2099-01-01').run();
  }
  const env = { HTV_DB: db };
  const call = (path, user = 'danny', method = 'GET', body, extraEnv = {}) => worker.fetch(new Request(`${origin}${path}`, {
    method,
    headers: { Cookie: `htv_session=provision-${user}`, ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }), { ...env, ...extraEnv });
  return { db, sqlite, call };
}

test('Access includes a separate mobile preview and exact-email confirmation for human owner', () => {
  const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(html, /id="provision-super-admin-form"/);
  assert.match(html, /id="provision-super-admin-preview"/);
  assert.match(html, /id="provision-super-admin-confirm"/);
  assert.match(html, /id="provision-super-admin-readback"/);
  assert.match(html, /api\/admin\/provision-super-admin/);
});

test('human super-admin previews and provisions a new named account without login or verification', async t => {
  const { db, call } = await fixture(t);
  const email = 'new-owner@example.test';
  const preview = await call(`/api/admin/provision-super-admin?email=${encodeURIComponent(email)}`);
  assert.equal(preview.status, 200, await preview.clone().text());
  assert.equal((await preview.json()).account, null);
  const result = await call('/api/admin/provision-super-admin', 'danny', 'POST', {
    email, name: 'New Owner', expected_user_id: null, confirm_email: email
  });
  assert.equal(result.status, 200, await result.clone().text());
  const data = await result.json();
  assert.equal(data.account.email, email);
  assert.equal(data.account.name, 'New Owner');
  assert.equal(data.role.role, 'super_admin');
  assert.equal(data.role.scope_type, 'global');
  assert.equal(data.role.scope_id, '*');
  assert.equal((await db.prepare('SELECT count(*) n FROM user_sessions WHERE user_id=?').bind(data.account.id).first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) n FROM audit_events WHERE target_id=? AND action=? AND actor_user_id=?').bind(data.account.id, 'provision_super_admin', DEMO_USERS.danny).first()).n, 1);
  assert.equal((await db.prepare("SELECT count(*) n FROM roles WHERE user_id=? AND role='super_admin' AND revoked_at IS NULL").bind(DEMO_USERS.danny).first()).n, 1);
  const readback = await call(`/api/admin/provision-super-admin?email=${encodeURIComponent(email)}`);
  assert.equal((await readback.json()).role.user_id, data.account.id);
});

test('existing account retains identity and metadata; confirmed grant is read back without duplication', async t => {
  const { db, call } = await fixture(t);
  const id = DEMO_USERS.member;
  const old = await db.prepare('SELECT id,email,name,first_name,metadata_json,created_at FROM users WHERE id=?').bind(id).first();
  const email = old.email;
  const preview = await (await call(`/api/admin/provision-super-admin?email=${email}`)).json();
  assert.equal(preview.account.id, id);
  const result = await call('/api/admin/provision-super-admin', 'danny', 'POST', { email, name: 'Overwrite attempt', expected_user_id: id, confirm_email: email });
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal((await result.json()).account_created, false);
  assert.deepEqual(await db.prepare('SELECT id,email,name,first_name,metadata_json,created_at FROM users WHERE id=?').bind(id).first(), old);
  assert.equal((await db.prepare('SELECT count(*) n FROM users WHERE lower(email)=?').bind(email).first()).n, 1);
  assert.equal((await db.prepare("SELECT count(*) n FROM roles WHERE user_id=? AND role='super_admin' AND scope_type='global' AND revoked_at IS NULL").bind(id).first()).n, 1);
  assert.equal((await call('/api/admin/provision-super-admin', 'danny', 'POST', { email, expected_user_id: id, confirm_email: email })).status, 409);
});

test('new account and role roll back together when audit fails', async t => {
  const { db, call } = await fixture(t);
  await db.exec("CREATE TRIGGER fail_provision_audit BEFORE INSERT ON audit_events WHEN NEW.action='provision_super_admin' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END;");
  const email = 'rollback@example.test';
  assert.equal((await call('/api/admin/provision-super-admin', 'danny', 'POST', { email, name: 'Rollback', expected_user_id: null, confirm_email: email })).status, 500);
  assert.equal((await db.prepare('SELECT count(*) n FROM users WHERE email=?').bind(email).first()).n, 0);
  assert.equal((await db.prepare("SELECT count(*) n FROM roles WHERE role='super_admin'").first()).n, 1);
});

test('human super-admin only: admin, organizer, bootstrap and stale/mismatched confirmation cannot provision', async t => {
  const { db, call } = await fixture(t);
  const email = 'denied@example.test';
  const payload = { email, name: 'Denied', expected_user_id: null, confirm_email: email };
  for (const user of ['alex', 'member']) {
    assert.equal((await call(`/api/admin/provision-super-admin?email=${email}`, user)).status, 403);
    assert.equal((await call('/api/admin/provision-super-admin', user, 'POST', payload)).status, 403);
  }
  assert.equal((await call('/api/admin/provision-super-admin', 'danny', 'POST', { ...payload, confirm_email: 'wrong@example.test' })).status, 400);
  assert.equal((await call('/api/admin/provision-super-admin', 'danny', 'POST', { ...payload, expected_user_id: DEMO_USERS.member })).status, 409);
  assert.equal((await call('/api/admin/provision-super-admin', 'danny', 'POST', { ...payload, name: '' })).status, 400);
  assert.equal((await call('/api/admin/provision-super-admin', 'danny', 'POST', { ...payload, email: 'invalid' })).status, 400);
  const crossOrigin = new Request(`${origin}/api/admin/provision-super-admin`, { method: 'POST', headers: { Cookie: 'htv_session=provision-danny', Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await worker.fetch(crossOrigin, { HTV_DB: db })).status, 403);
  assert.equal((await call('/api/admin/provision-super-admin', 'danny', 'POST', { ...payload, email: 'danny@example.com', expected_user_id: DEMO_USERS.danny, confirm_email: 'danny@example.com' })).status, 403);
  const bootstrap = new Request(`${origin}/api/admin/provision-super-admin`, { method: 'POST', headers: { Authorization: 'Bearer recovery', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await worker.fetch(bootstrap, { HTV_DB: db, HTV_ADMIN_TOKEN: 'recovery', HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED: '1' })).status, 403);
  assert.equal((await db.prepare('SELECT count(*) n FROM users WHERE email=?').bind(email).first()).n, 0);
});

test('vault capacity rejects provision atomically without losing owner role', async t => {
  const { db, call } = await fixture(t);
  for (let n = 0; n < 13; n++) {
    await db.prepare('INSERT INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)').bind(`seat_${n}`, `seat_${n}@example.test`, '2026-01-01', '2026-01-01').run();
    await db.prepare("INSERT INTO social_vault_members(user_id,role,granted_at) VALUES(?,'member','2026-01-01')").bind(`seat_${n}`).run();
  }
  const email = 'capacity@example.test';
  const result = await call('/api/admin/provision-super-admin', 'danny', 'POST', { email, name: 'Capacity', expected_user_id: null, confirm_email: email });
  assert.equal(result.status, 409, await result.clone().text());
  assert.equal((await db.prepare('SELECT count(*) n FROM users WHERE email=?').bind(email).first()).n, 0);
  assert.equal((await db.prepare("SELECT count(*) n FROM roles WHERE user_id=? AND role='super_admin' AND revoked_at IS NULL").bind(DEMO_USERS.danny).first()).n, 1);
});
