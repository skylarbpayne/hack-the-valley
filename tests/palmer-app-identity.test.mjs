import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import worker from '../worker.js';
import { createSponsorshipDb } from './helpers/sponsorship-db.mjs';
import { parseArgs, runClient } from '../scripts/htv-palmer-client.mjs';

const host = 'https://palmer.hackthevalley.org';
const issuer = 'https://fixture.cloudflareaccess.com';
const audience = 'fixture-audience';
const client = 'palmer-fixture.access';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
function assertion(overrides = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT' })}.${encode({ type: 'app', iss: issuer, aud: [audience], common_name: client, sub: '', iat: now, exp: now + 300, ...overrides })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
function req(path, method = 'GET', data, token = assertion(), base = host) {
  return new Request(`${base}${path}`, { method, headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}) }, body: data ? JSON.stringify(data) : undefined });
}
async function fixture(t) {
  const { db, sqlite, close } = await createSponsorshipDb(); t.after(close);
  sqlite.exec("INSERT INTO users(id,email,name,created_at,updated_at) VALUES ('usr_palmer','palmer@example.com','Palmer Fixture',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),('usr_mofe','mofmofcool@gmail.com','Mofe Fixture',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)");
  sqlite.exec("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at) VALUES ('role_palmer','usr_palmer','super_admin','global','*',CURRENT_TIMESTAMP)");
  sqlite.exec("INSERT INTO events(slug,title,status,created_at,updated_at) VALUES ('hack-hours','Hack Hours','open',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),('demo-hours','Demo Hours','open',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)");
  const env = { HTV_DB: db, HTV_SERVICE_ENABLED: '1', HTV_ACCESS_HOST: 'palmer.hackthevalley.org', HTV_ACCESS_ISSUER: issuer, HTV_ACCESS_AUDIENCE: audience, HTV_ACCESS_CLIENT_ID: client, HTV_ACCESS_PRINCIPAL_EMAIL: 'palmer@example.com' };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => { assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys: [jwk] })); };
  t.after(() => { globalThis.fetch = oldFetch; });
  return { sqlite, env, call: (path, method, data, token, base) => worker.fetch(req(path, method, data, token, base), env) };
}

test('named Palmer app principal exercises super-admin, cross-event and Mofe-only assignment with readback', async t => {
  const { sqlite, call } = await fixture(t);
  const me = await call('/api/admin/me'); assert.equal(me.status, 200);
  assert.equal((await me.json()).capabilities.super_admin, true);
  assert.equal((await call('/api/admin/workflows')).status, 200);
  assert.equal((await call('/api/social-vault')).status, 200);
  for (const slug of ['hack-hours', 'demo-hours']) {
    const response = await call(`/api/events/${slug}`, 'PATCH', { title: `${slug} updated` });
    assert.equal(response.status, 200, await response.clone().text());
  }
  const grant = await call('/api/admin/roles', 'POST', { email: 'mofmofcool@gmail.com', role: 'organizer', scope_type: 'event', scope_id: 'hack-hours', action: 'grant' });
  assert.equal(grant.status, 200, await grant.clone().text());
  const roles = await call('/api/admin/roles'); assert.equal(roles.status, 200);
  assert.deepEqual((await roles.json()).roles.filter(r => r.email === 'mofmofcool@gmail.com').map(r => [r.role,r.scope_type,r.scope_id]), [['organizer','event','hack-hours']]);
  assert.equal(sqlite.prepare("SELECT granted_by_user_id FROM roles WHERE user_id='usr_mofe' AND scope_id='hack-hours'").get().granted_by_user_id, 'usr_palmer');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM roles WHERE user_id='usr_mofe' AND scope_type='global' AND revoked_at IS NULL").get().n, 0);
  assert.equal((await call('/api/admin/roles', 'POST', { email: 'palmer@example.com', role: 'admin', action: 'grant' })).status, 403, 'no self-grant');
  const provision = { email: 'service-created@example.test', name: 'Service Created', expected_user_id: null, confirm_email: 'service-created@example.test' };
  assert.equal((await call('/api/admin/provision-super-admin')).status, 403, 'service cannot preview');
  assert.equal((await call('/api/admin/provision-super-admin', 'POST', provision)).status, 403, 'service cannot provision');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM users WHERE email='service-created@example.test'").get().n, 0);
});

test('provider-disable, wrong host, missing config, invalid JWT and role revocation deny', async t => {
  const { sqlite, env, call } = await fixture(t);
  for (const token of ['', assertion({ aud: ['other'] }), assertion({ iss: 'https://wrong.cloudflareaccess.com' }), assertion({ common_name: 'different.access' }), assertion({ exp: 1 }), assertion({ sub: 'human', email: 'palmer@example.com' }), assertion({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)]) {
    assert.notEqual((await call('/api/admin/roles', 'GET', undefined, token)).status, 200);
  }
  assert.equal((await call('/api/admin/roles', 'GET', undefined, assertion(), 'https://hackthevalley.org')).status, 401);
  assert.equal((await worker.fetch(req('/api/admin/roles'), { ...env, HTV_SERVICE_ENABLED: '0' })).status, 401);
  assert.equal((await worker.fetch(req('/api/admin/roles'), { ...env, HTV_ACCESS_CLIENT_ID: '' })).status, 401);
  sqlite.exec("UPDATE roles SET revoked_at=CURRENT_TIMESTAMP WHERE user_id='usr_palmer'");
  assert.equal((await call('/api/admin/roles')).status, 403);
});

test('private diagnostic emits only a fixed stage, only for denied named probes', async t => {
  const { env, sqlite } = await fixture(t);
  const counts = () => sqlite.prepare('SELECT stage,hits FROM palmer_auth_stage_counts').all().map(x => [x.stage,x.hits]);
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  const path = '/api/admin/me';
  const mixed = req(path); mixed.headers.set('Cookie', 'fixture-sensitive-marker');
  for (const [stage, request, overrides] of [
    ['db_binding', req(path), { HTV_DB: null }],
    ['config', req(path), { HTV_SERVICE_ENABLED: '0' }],
    ['session_header', mixed, {}],
    ['missing_assertion', req(path, 'GET', undefined, ''), {}],
    ['jwt_verification', req(path, 'GET', undefined, 'fixture-sensitive-marker'), {}],
    ['service_claims', req(path, 'GET', undefined, assertion({ sub: 'fixture-sensitive-marker' })), {}],
    ['user_lookup', req(path), { HTV_DB: { prepare() { throw Error('fixture-sensitive-marker'); } } }],
    ['user_match', req(path), { HTV_ACCESS_PRINCIPAL_EMAIL: 'absent@example.com' }],
  ]) {
    const res = await worker.fetch(request, { ...env, ...overrides });
    assert.equal(res.status, 401); assert.equal(await res.text(), 'Unauthorized');
    const expected = ['db_binding','user_lookup'].includes(stage) ? [] : [[stage,1]];
    assert.deepEqual(counts(), expected);
    sqlite.exec('DELETE FROM palmer_auth_stage_counts');
    assert.deepEqual(logs, []);
  }
  assert.equal((await worker.fetch(req(path), env)).status, 200);
  for (const request of [req('/api/admin/roles', 'GET', undefined, ''), req(path, 'POST', undefined, ''), req(path, 'GET', undefined, assertion(), 'https://hackthevalley.org')]) {
    assert.equal((await worker.fetch(request, env)).status, 401);
  }
  assert.deepEqual(logs, []);
  const goodFetch = globalThis.fetch; let attempts = 0;
  globalThis.fetch = (...args) => ++attempts === 1 ? goodFetch(...args) : Promise.reject(Error('fixture-sensitive-marker'));
  assert.equal((await worker.fetch(req(path), env)).status, 401);
  assert.deepEqual(counts(), [['route_auth', 1]]);
  assert.deepEqual(logs, []);
});

test('operator client uses Access headers on the dedicated API hostname for app RBAC', async t => {
  const { env } = await fixture(t);
  const body = { email: 'mofmofcool@gmail.com', role: 'organizer', scope_type: 'event', scope_id: 'hack-hours', action: 'grant' };
  const result = await runClient(parseArgs(['POST', '/api/admin/roles']), body,
    { CF_ACCESS_CLIENT_ID: client, CF_ACCESS_CLIENT_SECRET: 'local-fixture-secret' },
    async (url, init) => {
      assert.equal(url, `${host}/api/admin/roles`);
      assert.equal(init.headers['CF-Access-Client-Id'], client);
      assert.equal(init.headers['CF-Access-Client-Secret'], 'local-fixture-secret');
      assert.equal(init.headers.Origin, host);
      assert.deepEqual(JSON.parse(init.body), body);
      return worker.fetch(req('/api/admin/roles', 'POST', body), env);
    });
  assert.equal(result.roles.some(r => r.email === 'mofmofcool@gmail.com' && r.scope_id === 'hack-hours'), true);
  assert.throws(() => parseArgs(['GET', '//evil.example/api/admin/me']));
  assert.throws(() => parseArgs(['GET', '/api/../social-vault']));
  assert.throws(() => parseArgs(['POST', '/api/social-vault/accounts/id/reveal']));
});
