import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import worker from '../worker.js';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';
import { sponsorHash } from '../functions/_lib/domain/sponsorships.js';

const origin = 'https://hackthevalley.org';
const issuer = 'https://fixture.cloudflareaccess.com';
const audience = 'fixture-audience';
const client = 'fixture-client.access';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
function assertion(overrides = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT' })}.${encode({ type: 'app', iss: issuer, aud: [audience], common_name: client, sub: '', iat: now, exp: now + 300, ...overrides })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
function request(path, method = 'GET', body, headers = {}) {
  return new Request(`${origin}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json', ...(path === activation ? { Origin: origin } : {}) } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
}
const service = '/api/service/hack-hours-organizers';
const activation = '/api/admin/hack-hours-service';
const body = { email: 'member@example.com', action: 'grant' };

test('fixture service identity needs admin activation; grants only event:hack-hours and reads back', async t => {
  const { db, sqlite, close } = await createSponsorshipDb(); t.after(close);
  for (const [name, id] of Object.entries(DEMO_USERS)) {
    await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
      .bind(`service-session-${name}`, id, await sponsorHash(`token-${name}`), '2026-01-01', '2099-01-01').run();
  }
  const env = { HTV_DB: db, HTV_ACCESS_ISSUER: issuer, HTV_ACCESS_AUDIENCE: audience };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => { assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }); };
  t.after(() => { globalThis.fetch = oldFetch; });
  const machine = (method = 'GET', data = undefined, jwt = assertion()) => worker.fetch(request(service, method, data, { 'Cf-Access-Jwt-Assertion': jwt }), env);
  const admin = (data, cookie = 'token-danny') => worker.fetch(request(activation, 'POST', data, { cookie: `htv_session=${cookie}` }), env);
  assert.equal((await machine('POST', body)).status, 403);
  assert.equal((await admin({ client_id: client, email: 'member@example.com', action: 'activate' }, 'token-member')).status, 403);
  assert.equal((await worker.fetch(request(activation, 'POST', { client_id: client, email: 'member@example.com', action: 'activate' }, { cookie: 'htv_session=token-danny', Origin: 'https://other.example' }), env)).status, 403);
  assert.equal((await admin({ client_id: client, email: 'member@example.com', action: 'activate' })).status, 200);
  assert.equal((await machine('POST', body)).status, 200);
  const read = await machine(); assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).roles.map(r => [r.email, r.role, r.scope_type, r.scope_id]), [['member@example.com', 'organizer', 'event', 'hack-hours']]);
  assert.equal(sqlite.prepare("SELECT granted_by_user_id FROM roles WHERE user_id=? AND scope_type='event' AND scope_id='hack-hours'").get(DEMO_USERS.member).granted_by_user_id, null);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM audit_events WHERE action='grant_organizer' AND scope_id='hack-hours'").get().n, 1);
  assert.equal((await machine('POST', { ...body, scope_type: 'global' })).status, 400);
  assert.equal((await machine('POST', { ...body, role: 'admin' })).status, 400);
  assert.equal((await machine('POST', { ...body, email: 'danny@example.com' })).status, 403);
  sqlite.exec("CREATE TRIGGER deny_service_audit BEFORE INSERT ON audit_events WHEN NEW.action='revoke_organizer' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  assert.equal((await machine('POST', { ...body, action: 'revoke' })).status, 500);
  assert.equal((await machine().then(r => r.json())).roles.length, 1, 'failed audit rolls back revoke');
  sqlite.exec('DROP TRIGGER deny_service_audit');
  assert.equal((await machine('POST', { ...body, action: 'revoke' })).status, 200);
  assert.equal((await machine()).status, 200);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM roles WHERE user_id=? AND scope_type='event' AND revoked_at IS NULL").get(DEMO_USERS.member).n, 0);
  assert.equal((await admin({ client_id: client, action: 'revoke' })).status, 200);
  assert.equal((await machine('POST', body)).status, 403);
});

test('unsigned, wrong audience, issuer, identity, expiry, forged signature, bootstrap denied', async t => {
  const { db, close } = await createSponsorshipDb(); t.after(close);
  const env = { HTV_DB: db, HTV_ACCESS_ISSUER: issuer, HTV_ACCESS_AUDIENCE: audience, HTV_ADMIN_TOKEN: 'fixture-bootstrap', HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED: '1' };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  t.after(() => { globalThis.fetch = oldFetch; });
  assert.equal((await worker.fetch(request(activation, 'POST', { client_id: client, email: 'member@example.com', action: 'activate' }, { Authorization: 'Bearer fixture-bootstrap' }), env)).status, 403);
  for (const jwt of ['', assertion({ aud: ['other'] }), assertion({ iss: 'https://other.cloudflareaccess.com' }), assertion({ common_name: 'another.access' }), assertion({ exp: 1 }), assertion({ sub: 'user', email: 'admin@example.com' }), assertion({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)]) {
    const result = await worker.fetch(request(service, 'POST', body, jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), env);
    assert.notEqual(result.status, 200);
  }
});
