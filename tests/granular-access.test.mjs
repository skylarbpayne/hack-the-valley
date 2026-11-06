import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';
import { sponsorHash } from '../functions/_lib/domain/sponsorships.js';

const origin = 'http://localhost:8788';
const request = (path, user = 'member', method = 'GET', body) => new Request(`${origin}${path}`, {
  method,
  headers: { Cookie: `htv_session=granular-${user}`, ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined
});

async function fixture(t) {
  const { db, close } = await createSponsorshipDb();
  t.after(close);
  for (const [name, id] of Object.entries(DEMO_USERS)) {
    await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
      .bind(`granular-session-${name}`, id, await sponsorHash(`granular-${name}`), '2026-01-01', '2099-01-01').run();
  }
  await db.prepare("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at) VALUES('scoped-organizer',?,'organizer','event','synthetic-event','2026-01-01')").bind(DEMO_USERS.member).run();
  for (const slug of ['synthetic-event', 'another-event']) {
    await db.prepare("INSERT INTO events(slug,title,status,created_at,updated_at) VALUES(?,?,'open','2026-01-01','2026-01-01')").bind(slug, slug).run();
    await db.prepare("INSERT INTO event_instances(id,event_slug,instance_key,status,created_at,updated_at) VALUES(?,?,'one','open','2026-01-01','2026-01-01')").bind(`inst_${slug}`, slug).run();
  }
  await db.prepare("INSERT INTO signups(id,event_slug,event_instance_id,user_id,name,created_at,updated_at) VALUES('signup-synthetic','synthetic-event','inst_synthetic-event',?,'Member Demo','2026-01-01','2026-01-01')").bind(DEMO_USERS.member).run();
  const env = { HTV_DB: db, HTV_SOCIAL_VAULT_KEY: Buffer.alloc(32, 7).toString('base64') };
  return { db, call: (path, user, method, body) => worker.fetch(request(path, user, method, body), env) };
}

test('scoped organizer updates assigned event and checks in an existing signup, not other events or admin/vault routes', async t => {
  const { db, call } = await fixture(t);
  assert.equal((await call('/api/admin/me')).status, 200);
  assert.equal((await call('/api/admin/me').then(response => response.json())).capabilities.role_management, false);
  assert.equal((await call('/api/admin/roles', 'member', 'POST', { email: 'member@example.com', role: 'organizer', action: 'grant' })).status, 403);
  assert.equal((await call('/api/events/synthetic-event', 'member', 'PATCH', { title: 'Synthetic event revised' })).status, 200);
  assert.equal((await call('/api/events/another-event', 'member', 'PATCH', { title: 'Wrong event' })).status, 403);
  assert.equal((await call('/api/events', 'member', 'POST', { title: 'Unauthorized create' })).status, 403);
  assert.equal((await call('/api/events/another-event/checkins?query=Member')).status, 403);
  const roster = await call('/api/events/synthetic-event/checkins?query=Member&instance_id=inst_synthetic-event');
  assert.equal(roster.status, 200, await roster.clone().text());
  assert.equal((await roster.json()).candidates[0].id, DEMO_USERS.member);
  const checkin = await call('/api/events/synthetic-event/checkins', 'member', 'POST', { user_id: DEMO_USERS.member, event_instance_id: 'inst_synthetic-event' });
  assert.equal(checkin.status, 201, await checkin.clone().text());
  assert.equal((await checkin.json()).signup.user_id, DEMO_USERS.member);
  const state = await db.prepare("SELECT checked_in_at FROM event_participant_current_state WHERE event_instance_id='inst_synthetic-event' AND user_id=?").bind(DEMO_USERS.member).first();
  assert.ok(state.checked_in_at);
  assert.equal((await call('/api/events/synthetic-event/checkins', 'member', 'POST', { user_id: DEMO_USERS.alex, event_instance_id: 'inst_synthetic-event' })).status, 403);
  assert.equal((await call('/api/admin/roles')).status, 403);
  assert.equal((await call('/api/admin/message-drafts/audience')).status, 403);
  assert.equal((await call('/api/admin/sponsorships')).status, 403);
  assert.equal((await call('/api/social-vault')).status, 403);
  assert.equal((await call('/api/events/another-event/instances/inst_another-event/photos')).status, 403);
  assert.equal((await call('/api/events/synthetic-event/instances/inst_synthetic-event/photos')).status, 200);
  assert.equal((await call('/api/events/synthetic-event/instances/inst_synthetic-event/followup')).status, 403);
});

test('global admin can read roles and vault while organizer UI remains a separate narrow surface', async t => {
  const { call } = await fixture(t);
  assert.equal((await call('/api/admin/roles', 'alex')).status, 200);
  assert.equal((await call('/api/social-vault', 'alex')).status, 200);
  const ui = readFileSync(new URL('../public/organizer.html', import.meta.url), 'utf8');
  assert.match(ui, /Event operations/);
  assert.doesNotMatch(ui, /api\/admin\/message-drafts|api\/admin\/roles/);
  assert.match(ui, /href="\/admin-sponsorships"/);
  const adminUi = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(adminUi, /<select name="role"/);
  assert.match(adminUi, /role_management/);
  const sponsorshipUi = readFileSync(new URL('../public/admin-sponsorships.html', import.meta.url), 'utf8');
  assert.match(sponsorshipUi, /href="\/organizer"/);
});

test('signed-in global admins manage organizers but only super-admins manage admins', async t => {
  const { db, call } = await fixture(t);
  for (const action of ['grant', 'revoke']) {
    assert.equal((await call('/api/admin/roles', 'alex', 'POST', { email: 'member@example.com', role: 'admin', action })).status, 403);
    assert.equal((await call('/api/admin/roles', 'member', 'POST', { email: 'member@example.com', role: 'organizer', action })).status, 403);
  }
  assert.equal((await call('/api/admin/me', 'alex').then(response => response.json())).capabilities.role_management, true);
  assert.equal((await call('/api/admin/me', 'danny').then(response => response.json())).capabilities.role_management, true);
  const token = new Request(`${origin}/api/admin/roles`, { method: 'POST', headers: { Authorization: 'Bearer recovery', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'member@example.com', role: 'organizer', action: 'grant' }) });
  assert.equal((await worker.fetch(token, { HTV_DB: db, HTV_ADMIN_TOKEN: 'recovery', HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED: '1' })).status, 403);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM roles WHERE user_id=? AND scope_type='global'").bind(DEMO_USERS.member).first()).n, 0);
  const organizerGrant = await call('/api/admin/roles', 'alex', 'POST', { email: 'member@example.com', role: 'organizer', action: 'grant' });
  assert.equal(organizerGrant.status, 200, await organizerGrant.clone().text());
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM roles WHERE user_id=? AND role='organizer' AND revoked_at IS NULL").bind(DEMO_USERS.member).first()).n, 2);
  assert.equal((await call('/api/admin/roles', 'alex', 'POST', { email: 'member@example.com', role: 'organizer', action: 'revoke' })).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM roles WHERE user_id=? AND role='organizer' AND scope_type='global' AND revoked_at IS NULL").bind(DEMO_USERS.member).first()).n, 0);
  for (const role of ['organizer', 'admin']) {
    const granted = await call('/api/admin/roles', 'danny', 'POST', { email: 'member@example.com', role, action: 'grant' });
    assert.equal(granted.status, 200, await granted.clone().text());
    assert.ok((await granted.json()).roles.some(row => row.user_id === DEMO_USERS.member && row.role === role));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action=? AND actor_user_id=? AND target_id=?').bind(`grant_${role}`, DEMO_USERS.danny, DEMO_USERS.member).first()).n, 1);
    if (role === 'organizer') {
      assert.equal((await call('/api/admin/sponsorships')).status, 200);
      assert.equal((await call('/api/social-vault')).status, 403);
      assert.equal((await call('/api/admin/message-drafts/audience')).status, 403);
    }
  }
  assert.equal((await call('/api/admin/roles', 'danny', 'POST', { email: 'member@example.com', role: 'super_admin', action: 'grant' })).status, 400);
  assert.equal((await call('/api/admin/roles', 'danny', 'POST', { email: 'member@example.com', role: 'super_admin', action: 'revoke' })).status, 400);
  assert.equal((await call('/api/admin/roles', 'danny', 'POST', { email: 'member@example.com', role: 'organizer', scope_type: 'event', action: 'grant' })).status, 400);
  for (const role of ['organizer', 'admin']) {
    const revoked = await call('/api/admin/roles', 'danny', 'POST', { email: 'member@example.com', role, action: 'revoke' });
    assert.equal(revoked.status, 200, await revoked.clone().text());
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action=? AND actor_user_id=? AND target_id=?').bind(`revoke_${role}`, DEMO_USERS.danny, DEMO_USERS.member).first()).n, 1);
  }
});

test('admin grant reports a capacity conflict instead of assigning a sixteenth effective person', async t => {
  const { db, call } = await fixture(t);
  for (let n = 0; n < 13; n++) {
    await db.prepare('INSERT INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)')
      .bind(`seat_${n}`, `seat_${n}@example.test`, '2026-01-01', '2026-01-01').run();
    await db.prepare("INSERT INTO social_vault_members(user_id,role,granted_at) VALUES(?,'member','2026-01-01')").bind(`seat_${n}`).run();
  }
  await db.prepare("INSERT INTO users(id,email,created_at,updated_at) VALUES('overflow-user','overflow@example.test','2026-01-01','2026-01-01')").run();
  const result = await call('/api/admin/roles', 'danny', 'POST', { email:'overflow@example.test', action:'grant' });
  assert.equal(result.status, 409, await result.clone().text());
  assert.match((await result.json()).error, /15 vault-access seats/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM roles WHERE user_id='overflow-user'").first()).n, 0);
});

test('role grants roll back if their audit event cannot be stored', async t => {
  const { db, call } = await fixture(t);
  await db.exec("CREATE TRIGGER fail_role_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'grant_organizer' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END;");
  assert.equal((await call('/api/admin/roles', 'danny', 'POST', { email: 'member@example.com', role: 'organizer', action: 'grant' })).status, 500);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM roles WHERE user_id=? AND role='organizer' AND scope_type='global'").bind(DEMO_USERS.member).first()).n, 0);
});
