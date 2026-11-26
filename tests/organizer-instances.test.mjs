import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import worker from '../worker.js';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';
import { sponsorHash } from '../functions/_lib/domain/sponsorships.js';

test('organizer UI exposes selected-instance close/open and explicit new date while retaining check-in', () => {
  const html = readFileSync(new URL('../public/organizer.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../public/organizer.js', import.meta.url), 'utf8');
  assert.match(html, /id="new-instance"/);
  assert.match(html, /id="instance-status"/);
  assert.match(html, /id="search"/);
  assert.match(script, /\/instances/);
  assert.match(script, /checkins\?query/);
  const admin = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(admin, /name="scope_type"/);
  assert.match(admin, /name="scope_id"/);
});

test('Pacific organizer date input converts winter and summer wall times independently of browser zone', () => {
  const script = readFileSync(new URL('../public/organizer.js', import.meta.url), 'utf8');
  const source = script.slice(script.indexOf('const pacific ='), script.indexOf('function eventRecord()'));
  const convert = runInNewContext(`${source}\npacific`, { Date, Intl, Error, Number });
  assert.equal(convert('2026-12-05T09:00'), '2026-12-05T17:00:00.000Z');
  assert.equal(convert('2026-12-05T11:00'), '2026-12-05T19:00:00.000Z');
  assert.equal(convert('2026-07-11T09:00'), '2026-07-11T16:00:00.000Z');
});

const origin = 'http://localhost:8788';
async function fixture(t) {
  const { db, close } = await createSponsorshipDb();
  t.after(close);
  for (const [name, id] of Object.entries(DEMO_USERS)) {
    await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
      .bind(`instance-session-${name}`, id, await sponsorHash(`instance-${name}`), '2026-01-01', '2099-01-01').run();
  }
  for (const slug of ['hack-hours', 'other-event']) {
    await db.prepare("INSERT INTO events(slug,title,description,starts_at,ends_at,venue_name,venue_address,capacity,status,image_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(slug, slug, 'First Saturday monthly', '2026-11-07T17:00:00.000Z', '2026-11-07T19:00:00.000Z', 'Panera', '10900 Stockdale Hwy Ste 100', 10, 'open', '/november.png', '2026-01-01', '2026-01-01').run();
    await db.prepare("INSERT INTO event_instances(id,event_slug,instance_key,starts_at,ends_at,status,created_at,updated_at) VALUES(?,?,?,?,?,'open','2026-01-01','2026-01-01')")
      .bind(`inst_${slug}`, slug, '2026-11-07', '2026-11-07T17:00:00.000Z', '2026-11-07T19:00:00.000Z').run();
  }
  await db.prepare("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at) VALUES('scoped-hack',?,'organizer','event','hack-hours','2026-01-01')").bind(DEMO_USERS.member).run();
  const call = (path, user = 'member', method = 'GET', body) => worker.fetch(new Request(`${origin}${path}`, {
    method, headers: { Cookie: `htv_session=instance-${user}`, ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined
  }), { HTV_DB: db });
  return { db, call };
}

test('scoped organizer closes November and creates December without replacing history or URL', async t => {
  const { db, call } = await fixture(t);
  await db.prepare("INSERT INTO signups(id,event_slug,event_instance_id,user_id,name,created_at,updated_at) VALUES('nov-signup','hack-hours','inst_hack-hours',?,'November Guest','2026-01-01','2026-01-01')").bind(DEMO_USERS.member).run();
  const close = await call('/api/events/hack-hours/instances/inst_hack-hours', 'member', 'PATCH', { status: 'closed' });
  assert.equal(close.status, 200, await close.clone().text());
  const created = await call('/api/events/hack-hours/instances', 'member', 'POST', { starts_at: '2026-12-05T17:00:00Z', ends_at: '2026-12-05T19:00:00Z', status: 'open', image_url: null });
  assert.equal(created.status, 201, await created.clone().text());
  const data = await created.json();
  assert.equal(data.instance.id, 'inst_hack_hours_2026_12_05');
  const series = (await (await call('/api/events?include_archived=1')).json()).events.find(e => e.slug === 'hack-hours');
  assert.equal(series.active_instance_id, data.instance.id);
  assert.equal(series.starts_at, '2026-12-05T17:00:00.000Z');
  assert.equal(series.image_url, null);
  assert.deepEqual(series.instances.map(i => [i.instance_key, i.status]), [['2026-11-07','closed'], ['2026-12-05','open']]);
  const page = await (await call('/events/hack-hours/')).text();
  assert.match(page, /Dec 5, 2026/);
  assert.doesNotMatch(page, /november\.png/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM event_instances WHERE event_slug='hack-hours' AND status='open'").first()).n, 1);
  assert.equal((await db.prepare("SELECT event_instance_id FROM signups WHERE id='nov-signup'").first()).event_instance_id, 'inst_hack-hours');
  const copy = await call('/api/events/hack-hours', 'member', 'PATCH', { title: 'Hack Hours', description: 'First Saturday monthly, 9–11 AM Pacific.' });
  assert.equal(copy.status, 200, await copy.clone().text());
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM event_instances WHERE event_slug='hack-hours'").first()).n, 2);
  assert.equal((await db.prepare("SELECT starts_at FROM event_instances WHERE id='inst_hack-hours'").first()).starts_at, '2026-11-07T17:00:00.000Z');
});

test('instance operations reject other events, unauthorized callers, duplicate dates and ambiguous opens', async t => {
  const { db, call } = await fixture(t);
  const path = '/api/events/hack-hours/instances';
  assert.equal((await call(path, 'member', 'POST', { starts_at: 'bad', status: 'open' })).status, 400);
  assert.equal((await call('/api/events/other-event/instances/inst_other-event', 'member', 'PATCH', { status: 'closed' })).status, 403);
  assert.equal((await call('/api/events/hack-hours/instances/inst_other-event', 'member', 'PATCH', { status: 'closed' })).status, 404);
  assert.equal((await call(path, 'member', 'POST', { starts_at:'2026-12-05T17:00:00Z', ends_at:'2026-12-05T19:00:00Z', status:'open' })).status, 409);
  assert.equal((await call(path, 'member', 'POST', { starts_at:'2026-11-07T17:00:00Z', ends_at:'2026-11-07T19:00:00Z', status:'draft' })).status, 409);
  assert.equal((await call(path, 'member', 'POST', { starts_at:'2026-12-05T17:00:00Z', ends_at:'2026-12-05T19:00:00Z', status:'draft' })).status, 201);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM event_instances WHERE event_slug='hack-hours'").first()).n, 2);
});

test('database blocks a second open instance even when writers race after preflight', async t => {
  const { db } = await fixture(t);
  await assert.rejects(() => db.prepare("INSERT INTO event_instances(id,event_slug,instance_key,status,created_at,updated_at) VALUES('racing-instance','hack-hours','2026-12-05','open','2026-01-01','2026-01-01')").run(), /open instance/i);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM event_instances WHERE event_slug='hack-hours' AND status='open'").first()).n, 1);
});

test('signed-in admin assigns only a named event organizer, audit failure rolls back', async t => {
  const { db, call } = await fixture(t);
  const payload = { email: 'member@example.com', role:'organizer', scope_type:'event', scope_id:'other-event', action:'grant' };
  assert.equal((await call('/api/admin/roles', 'member', 'POST', payload)).status, 403);
  const granted = await call('/api/admin/roles', 'alex', 'POST', payload);
  assert.equal(granted.status, 200, await granted.clone().text());
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM roles WHERE user_id=? AND scope_type='global'").bind(DEMO_USERS.member).first()).n, 0);
  assert.equal((await call('/api/admin/sponsorships')).status, 403);
  assert.equal((await call('/api/social-vault')).status, 403);
  assert.equal((await call('/api/events/other-event/instances/inst_other-event', 'member', 'PATCH', { status:'closed' })).status, 200);
  assert.equal((await call('/api/admin/roles', 'alex', 'POST', { ...payload, action:'revoke' })).status, 200);
  assert.equal((await call('/api/events/other-event/instances/inst_other-event', 'member', 'PATCH', { status:'open' })).status, 403);
  await db.exec("CREATE TRIGGER fail_scoped_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'grant_organizer' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END;");
  assert.equal((await call('/api/admin/roles', 'alex', 'POST', payload)).status, 500);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM roles WHERE user_id=? AND scope_id='other-event' AND revoked_at IS NULL").bind(DEMO_USERS.member).first()).n, 0);
});
