import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';
import { sponsorHash } from '../functions/_lib/domain/sponsorships.js';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery as splitSql } from 'wrangler';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compatibilityFixtureSql, userFixtureSql } from '../scripts/sponsorship-fixtures.mjs';

const origin = 'http://localhost:8788';
async function fixture(t) {
  const { db, close } = await createSponsorshipDb(); t.after(close);
  for (const [name,id] of Object.entries(DEMO_USERS)) await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').bind(`vault-session-${name}`,id,await sponsorHash(`vault-token-${name}`),'2026-01-01','2099-01-01').run();
  await db.prepare("INSERT INTO social_vault_members(user_id,role,granted_at) VALUES(?,'owner','2026-01-01')").bind(DEMO_USERS.danny).run();
  return { HTV_DB: db, HTV_SOCIAL_VAULT_KEY: Buffer.alloc(32, 7).toString('base64') }; // synthetic test key only
}
const req = (path = '', { user = 'danny', method = 'GET', body, headers = {} } = {}) => new Request(`${origin}/api/social-vault${path}`, { method, headers: { ...(user ? { Cookie: `htv_session=vault-token-${user}` } : {}), ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers }, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
const call = (env,path,options) => worker.fetch(req(path,options),env);
const count = async (db,table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

test('vault grants live global admins, ignores bootstrap, requires member grant and same-origin reveal', async t => {
  const env = await fixture(t);
  assert.equal((await call(env,'',{user:null})).status,401);
  assert.equal((await call(env,'',{user:'alex'})).status,200, 'global admin has implicit vault access');
  assert.equal((await call(env,'',{user:'alex'}).then(r=>r.json())).role,'admin');
  assert.equal((await call({...env,HTV_ADMIN_TOKEN:'recovery',HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED:'1'},'',{user:null,headers:{Authorization:'Bearer recovery'}})).status,401);
  assert.equal((await call(env,'/members',{method:'POST',body:{email:'member@example.com',role:'member'},headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await call(env,'/members',{method:'POST',body:{email:'member@example.com',role:'member'},headers:{Origin:''}})).status,403);
  assert.equal((await call(env,'/members',{method:'POST',body:{email:'missing@example.com',role:'member'}})).status,404);
  assert.equal((await call(env,'/members',{method:'POST',body:{email:'member@example.com',role:'member'}})).status,200);
  assert.equal((await call(env,'',{user:'member'})).status,200);
  assert.equal((await call(env,'/accounts/sv_00000000000000000000000000000000/reveal',{user:'member',method:'POST',headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await call(env,'/members',{user:'member',method:'POST',body:{email:'alex@example.com',role:'owner'}})).status,403);
});

test('Access-compatible admin vault grant is member-only, revokes by listed user ID, and leaves roles untouched', async t => {
  const env = await fixture(t), db = env.HTV_DB;
  const granted = await call(env, '/members', { user: 'alex', method: 'POST', body: { email: 'member@example.com', role: 'member' } });
  assert.equal(granted.status, 200, await granted.clone().text());
  const listing = await call(env, '', { user: 'alex' }).then(r => r.json());
  const member = listing.members.find(row => row.email === 'member@example.com');
  assert.equal(member.user_id, DEMO_USERS.member);
  assert.equal(member.role, 'member');
  assert.equal(listing.capacity, 15);
  assert.equal(listing.effectiveCount, 3);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roles WHERE user_id=? AND revoked_at IS NULL').bind(DEMO_USERS.member).first()).n, 0);
  assert.equal((await call(env, '/members', { user: 'member', method: 'POST', body: { email: 'alex@example.com', role: 'member' } })).status, 403);
  const revoked = await call(env, `/members/${encodeURIComponent(member.user_id)}`, { user: 'alex', method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.match((await revoked.json()).rotationWarning, /Rotate every shared password/);
  assert.equal((await call(env, '', { user: 'member' })).status, 403);
  assert.equal((await call(env, '', { user: 'alex' })).status, 200, 'admin retains implicit access');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM social_vault_members WHERE user_id=? AND role='owner' AND revoked_at IS NULL").bind(DEMO_USERS.danny).first()).n, 1);
});

test('encrypted credentials preserve exact whitespace, are hidden in lists/audits, and revoke kills a live session', async t => {
  const env = await fixture(t), db = env.HTV_DB, password = '  synthetic test phrase  ';
  let response = await call(env,'/accounts',{method:'POST',body:{label:'Social A',login:'@synthetic',password}});
  assert.equal(response.status,201,await response.clone().text());
  const { id } = await response.json();
  assert.equal((await call(env,'',{user:'member'})).status,403);
  await call(env,'/members',{method:'POST',body:{email:'member@example.com',role:'member'}});
  response = await call(env,'',{user:'member'}); const list = await response.text();
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.doesNotMatch(list,/synthetic test phrase|@synthetic|ciphertext|iv/);
  const stored = await db.prepare('SELECT * FROM social_vault_accounts WHERE id=?').bind(id).first();
  assert.doesNotMatch(JSON.stringify(stored),/synthetic test phrase|@synthetic/);
  const bad = await call(env,`/accounts/${id}/reveal`,{user:'member',method:'POST',headers:{Origin:'https://evil.example'}});
  assert.equal(bad.status,403); assert.equal(bad.headers.get('Cache-Control'),'private, no-store');
  response = await call(env,`/accounts/${id}/reveal`,{user:'member',method:'POST'});
  assert.equal(response.status,200); assert.deepEqual((await response.json()).password,password);
  const log = JSON.stringify((await db.prepare("SELECT * FROM audit_events WHERE scope_type='social_vault'").all()).results);
  assert.doesNotMatch(log,/synthetic test phrase|@synthetic/);
  assert.match(log,/social_vault_reveal/);
  response = await call(env,`/members/${DEMO_USERS.member}`,{method:'DELETE'});
  assert.equal(response.status,200); assert.match((await response.json()).rotationWarning,/rotate/i);
  assert.equal((await call(env,'',{user:'member'})).status,403);
  assert.equal((await call(env,`/accounts/${id}/reveal`,{user:'member',method:'POST'})).status,403);
  assert.equal((await call(env,'/accounts',{user:'member',method:'POST',body:{label:'X',login:'x',password:'x'}})).status,403);
  assert.equal(await count(db,'social_vault_accounts'),1);
});

test('owner rotates credentials with revision fencing, audit rollback, and no account-count cap', async t => {
  const env = await fixture(t), db=env.HTV_DB;
  const ids=[];
  for(let n=0;n<5;n++) {
    const response=await call(env,'/accounts',{method:'POST',body:{label:`Social ${n}`,login:`synthetic${n}`,password:`not-a-real-secret-${n}`}});
    assert.equal(response.status,201,await response.clone().text()); ids.push((await response.json()).id);
  }
  const stale=await call(env,`/accounts/${ids[0]}`,{method:'PUT',body:{revision:2,label:'New',login:'x',password:'different'}});
  assert.equal(stale.status,409);
  assert.equal((await call(env,`/accounts/${ids[0]}`,{method:'PUT',body:{revision:1,label:'New',login:'x',password:'different'}})).status,200);
  assert.equal((await call(env,`/accounts/${ids[0]}/reveal`,{method:'POST'})).status,200);
  assert.equal((await db.prepare('SELECT revision FROM social_vault_accounts WHERE id=?').bind(ids[0]).first()).revision,2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='social_vault_update'").first()).n,1);
  assert.equal(await count(db,'social_vault_accounts'),5);
  assert.equal((await call(env,`/members/${DEMO_USERS.danny}`,{method:'DELETE'})).status,409,'last owner cannot be removed');
});

test('15-person cap is database-atomic across competing grants and revocation makes room', async t => {
  const env=await fixture(t), db=env.HTV_DB;
  for(let n=0;n<15;n++) await db.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)').bind(`vault_test_${n}`,`vault${n}@example.test`,'Synthetic','2026-01-01','2026-01-01').run();
  const grant=n=>call(env,'/members',{method:'POST',body:{email:`vault${n}@example.test`,role:'member'}});
  const results=await Promise.all(Array.from({length:15},(_,n)=>grant(n)));
  assert.equal(results.filter(r=>r.status===200).length,13);
  assert.equal(results.filter(r=>r.status===409).length,2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM social_vault_members WHERE revoked_at IS NULL').first()).n,14);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='social_vault_grant'").first()).n,13);
  const victim=(await db.prepare("SELECT user_id FROM social_vault_members WHERE role='member' AND revoked_at IS NULL LIMIT 1").first()).user_id;
  assert.equal((await call(env,`/members/${victim}`,{method:'DELETE'})).status,200);
  const missing=(await db.prepare("SELECT id,email FROM users WHERE id NOT IN (SELECT user_id FROM social_vault_members WHERE revoked_at IS NULL) AND id LIKE 'vault_test_%' LIMIT 1").first()).email;
  assert.equal((await call(env,'/members',{method:'POST',body:{email:missing,role:'member'}})).status,200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM social_vault_members WHERE revoked_at IS NULL').first()).n,14);
});

test('admin management, immediate revocation, membership fallback, and seat deduplication', async t => {
  const env = await fixture(t), db = env.HTV_DB;
  const created = await call(env, '/accounts', { user:'alex', method:'POST', body:{ label:'Synthetic', login:'test', password:'synthetic-only' } });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  assert.equal((await call(env, `/accounts/${id}/reveal`, { user:'alex', method:'POST' })).status, 200);
  assert.equal((await call(env, '/members', { user:'alex', method:'POST', body:{ email:'member@example.com', role:'member' } })).status, 200);
  assert.equal((await call(env, '/members', { user:'member', method:'POST', body:{ email:'alex@example.com', role:'owner' } })).status, 403);
  const before = (await call(env, '', { user:'alex' }).then(r=>r.json())).effectiveCount;
  assert.equal((await call(env, '/members', { method:'POST', body:{ email:'alex@example.com',role:'member' } })).status, 200);
  assert.equal((await call(env, '', { user:'alex' }).then(r=>r.json())).effectiveCount, before);
  await db.prepare("UPDATE roles SET revoked_at='2026-02-01' WHERE user_id=? AND role='admin'").bind(DEMO_USERS.alex).run();
  assert.equal((await call(env,'',{user:'alex'}).then(r=>r.json())).role, 'member');
  assert.equal((await call(env,`/accounts/${id}/reveal`,{user:'alex',method:'POST'})).status,200);
  assert.equal((await call(env,'/accounts',{user:'alex',method:'POST',body:{label:'No',login:'no',password:'no'}})).status,403);
  assert.equal((await call(env,`/members/${DEMO_USERS.alex}`,{method:'DELETE'})).status,200);
  assert.equal((await call(env,'',{user:'alex'})).status,403);
  assert.equal((await call(env,`/accounts/${id}/reveal`,{user:'alex',method:'POST'})).status,403);
});

test('database rejects a sixteenth effective admin and allows admin/member overlap', async t => {
  const env = await fixture(t), db=env.HTV_DB;
  for(let n=0;n<13;n++) await db.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)').bind(`seat_${n}`,`seat${n}@example.test`,'Synthetic','2026-01-01','2026-01-01').run();
  for(let n=0;n<13;n++) assert.equal((await call(env,'/members',{method:'POST',body:{email:`seat${n}@example.test`,role:'member'}})).status,200);
  await assert.rejects(db.prepare("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at) VALUES('seat-admin',?,'admin','global','*','2026-01-01')").bind(DEMO_USERS.member).run(), /full/i);
  await db.prepare("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at) VALUES('seat-overlap',?,'admin','global','*','2026-01-01')").bind('seat_0').run();
  assert.equal((await call(env,'',{user:'danny'}).then(r=>r.json())).effectiveCount,15);
  await db.prepare("UPDATE social_vault_members SET revoked_at='2026-02-01' WHERE user_id='seat_1'").run();
  await db.prepare("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at) VALUES('seat-admin',?,'admin','global','*','2026-01-01')").bind(DEMO_USERS.member).run();
  assert.equal((await call(env,'',{user:'danny'}).then(r=>r.json())).effectiveCount,15);
});

test('actual local D1 commits guarded writes and audit together, denies stale updates', async t => {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-02-17', d1Databases: { HTV_DB: 'social-vault-test' }, log: new Log(LogLevel.ERROR) });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('HTV_DB');
  const execute = sql => db.batch(splitSql(sql).map(statement => db.prepare(statement)));
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    await execute(readFileSync(`${directory}/${name}`, 'utf8'));
    if (name === '0013_event_project_awards.sql') await execute(compatibilityFixtureSql());
  }
  await execute(userFixtureSql());
  await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').bind('d1-session',DEMO_USERS.danny,await sponsorHash('vault-token-danny'),'2026-01-01','2099-01-01').run();
  await db.prepare("INSERT INTO social_vault_members(user_id,role,granted_at) VALUES(?,'owner','2026-01-01')").bind(DEMO_USERS.danny).run();
  const env={ HTV_DB:db, HTV_SOCIAL_VAULT_KEY: Buffer.alloc(32,7).toString('base64') };
  const first=await call(env,'/accounts',{method:'POST',body:{label:'D1 synthetic',login:'d1',password:' synthetic '}});
  assert.equal(first.status,201,await first.clone().text());
  const {id}=await first.json();
  assert.equal((await call(env,`/accounts/${id}`,{method:'PUT',body:{label:'Stale',login:'d1',password:'x',revision:2}})).status,409);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='social_vault_update'").first()).n,0);
  assert.equal((await call(env,`/accounts/${id}/reveal`,{method:'POST'})).status,200);
  assert.equal((await call(env,`/accounts/${id}`,{method:'PUT',body:{label:'Updated',login:'d1',password:' new ',revision:1}})).status,200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='social_vault_update'").first()).n,1);
});
