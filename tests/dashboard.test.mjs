import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';
import { sponsorHash } from '../functions/_lib/domain/sponsorships.js';

const origin = 'https://hackthevalley.org';
async function fixture(t) {
  const { db, close } = await createSponsorshipDb();
  t.after(close);
  for (const [name, id] of Object.entries(DEMO_USERS)) {
    await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
      .bind(`dashboard-${name}`, id, await sponsorHash(`dashboard-${name}`), '2026-01-01', '2099-01-01').run();
  }
  const call = (user, path = '/api/dashboard') => worker.fetch(new Request(`${origin}${path}`, {
    headers: user ? { Cookie: `htv_session=dashboard-${user}` } : {}
  }), { HTV_DB: db });
  const get = async user => {
    const response = await call(user);
    return { response, body: await response.json() };
  };
  return { db, get, call };
}
const ids = body => body.links.map(link => link.id);

test('dashboard requires a real session and cannot use a bootstrap bearer token', async t => {
  const { call, db } = await fixture(t);
  assert.equal((await call()).status, 401);
  const response = await worker.fetch(new Request(`${origin}/api/dashboard`, { headers: { Authorization: 'Bearer recovery' } }), { HTV_ADMIN_TOKEN: 'recovery', HTV_ADMIN_TOKEN_BOOTSTRAP: '1', HTV_DB: db });
  assert.equal(response.status, 401);
});

test('participant has only personal workspace; revoked roles do not expose tools', async t => {
  const { db, get } = await fixture(t);
  const member = (await get('member')).body;
  assert.deepEqual(ids(member), ['profile', 'my-projects']);
  assert.equal(member.capabilities.participant, true);
  assert.equal(member.capabilities.social_vault, null);
  assert.equal(member.capabilities.organizer, null);
  assert.equal(member.capabilities.admin, false);
  await db.prepare("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at,revoked_at) VALUES('revoked',?,'admin','global','*','2026-01-01','2026-02-01')").bind(DEMO_USERS.member).run();
  assert.deepEqual(ids((await get('member')).body), ids(member));
});

test('explicit vault member sees reveal-only shared logins, not organizer or admin', async t => {
  const { db, get } = await fixture(t);
  await db.prepare("INSERT INTO social_vault_members(user_id,role,granted_at) VALUES (?,'member','2026-01-01')").bind(DEMO_USERS.member).run();
  const body = (await get('member')).body;
  assert.deepEqual(ids(body), ['profile', 'my-projects', 'shared-logins']);
  assert.equal(body.capabilities.social_vault, 'member');
  assert.equal(body.capabilities.admin, false);
  await db.prepare('UPDATE social_vault_members SET revoked_at=? WHERE user_id=?').bind('2026-02-01', DEMO_USERS.member).run();
  assert.deepEqual(ids((await get('member')).body), ['profile', 'my-projects']);
});

test('explicit vault owner is distinct from member and can manage shared logins', async t => {
  const { db, get } = await fixture(t);
  await db.prepare("INSERT INTO social_vault_members(user_id,role,granted_at) VALUES (?,'owner','2026-01-01')").bind(DEMO_USERS.member).run();
  const body = (await get('member')).body;
  assert.equal(body.capabilities.social_vault, 'owner');
  assert.equal(body.links.find(link => link.id === 'shared-logins').href, '/shared-logins/');
  assert.deepEqual(ids(body), ['profile', 'my-projects', 'shared-logins']);
});

test('scoped organizer receives event operations for assigned event, not sponsorships', async t => {
  const { db, get } = await fixture(t);
  await db.prepare("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at) VALUES('scoped',?,'organizer','event','hack-hours','2026-01-01')").bind(DEMO_USERS.member).run();
  const body = (await get('member')).body;
  assert.deepEqual(body.capabilities.organizer, { scope: 'event', events: ['hack-hours'] });
  assert.deepEqual(ids(body), ['profile', 'my-projects', 'event-operations']);
  assert.equal(body.links.at(-1).href, '/organizer');
});

test('global organizer sees events and sponsorships but not vault or full admin', async t => {
  const { db, get } = await fixture(t);
  await db.prepare("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at) VALUES('global',?,'organizer','global','*','2026-01-01')").bind(DEMO_USERS.member).run();
  const body = (await get('member')).body;
  assert.deepEqual(body.capabilities.organizer, { scope: 'global', events: [] });
  assert.deepEqual(ids(body), ['profile', 'my-projects', 'event-operations', 'sponsorships']);
  assert.equal(body.links.at(-1).href, '/admin-sponsorships');
});

test('global admin and super-admin inherit vault and event access without explicit membership', async t => {
  const { get } = await fixture(t);
  for (const [user, superAdmin] of [['alex', false], ['danny', true]]) {
    const body = (await get(user)).body;
    assert.equal(body.capabilities.admin, true);
    assert.equal(body.capabilities.super_admin, superAdmin);
    assert.equal(body.capabilities.social_vault, 'admin');
    assert.deepEqual(ids(body), ['profile', 'my-projects', 'event-operations', 'sponsorships', 'shared-logins', 'site-admin']);
    assert.equal(body.links.at(-1).href, '/admin');
  }
});

test('dashboard UI is one shareable URL and consumes server-projected links without role guesses', () => {
  const html = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
  assert.match(html, /\/api\/dashboard/);
  assert.match(html, /\/login\/\?next=\/dashboard\//);
  assert.match(html, /data\.links/);
  assert.doesNotMatch(html, /roles\.some|social_vault_members|role ===/);
  assert.match(html, /name="viewport"/);
});
