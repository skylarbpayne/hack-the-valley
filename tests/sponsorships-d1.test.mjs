import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery as splitSql } from 'wrangler';
import { compatibilityFixtureSql, userFixtureSql, DEMO_USERS } from '../scripts/sponsorship-fixtures.mjs';
import { mutateSponsor, getSponsorMotion } from '../functions/_lib/domain/sponsorships.js';

// The fast tests use node:sqlite. This suite exercises the same domain against
// the actual workerd/Miniflare D1 implementation used by local Wrangler.
async function realD1(t) {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("local D1 test"); } };',
    compatibilityDate: '2026-02-17',
    d1Databases: { HTV_DB: 'sponsorship-transaction-tests' },
    log: new Log(LogLevel.ERROR),
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('HTV_DB');
  const execute = async sql => db.batch(splitSql(sql).map(statement => db.prepare(statement)));
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    await execute(readFileSync(`${directory}/${name}`, 'utf8'));
    if (name === '0013_event_project_awards.sql') await execute(compatibilityFixtureSql());
  }
  await execute(userFixtureSql());
  return db;
}

let sequence = 0;
const options = key => ({ actorUserId: DEMO_USERS.danny, key: key || `real-d1-operation-${++sequence}` });
const count = async (db, table, where = '1=1', values = []) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first()).n;
async function records(db) {
  const contact = (await mutateSponsor(db, 'contacts', null, { business_name: `D1 business ${++sequence}` }, options())).body.item;
  const campaign = (await mutateSponsor(db, 'campaigns', null, { name: 'D1 annual campaign', year: 2027 }, options())).body.item;
  return { contact, campaign };
}
const motionInput = ({ contact, campaign }, extra = {}) => ({ contact_id: contact.id, campaign_id: campaign.id, owner_user_id: DEMO_USERS.danny, ...extra });

test('actual local D1 preserves sponsorship transactions and concurrent retry contracts', async t => {
  const db = await realD1(t);

  await t.test('concurrent same-key creates commit once and return the saved response', async () => {
    const input = { business_name: 'Concurrent real-D1 prospect' }, opts = options('d1-concurrent-create');
    const responses = await Promise.all(Array.from({ length: 4 }, () => mutateSponsor(db, 'contacts', null, input, opts)));
    for (const response of responses) assert.deepEqual(response, responses[0]);
    const id = responses[0].body.item.id;
    assert.equal(await count(db, 'sponsor_contacts', 'id=?', [id]), 1);
    assert.equal(await count(db, 'audit_events', 'target_id=?', [id]), 1);
    assert.equal(await count(db, 'sponsorship_mutation_receipts', 'idempotency_key=?', [opts.key]), 1);
    await assert.rejects(mutateSponsor(db, 'contacts', null, { business_name: 'Changed payload' }, opts), error => error.status === 409);
  });

  await t.test('different keys cannot create duplicate business/campaign motions', async () => {
    const data = await records(db), input = motionInput(data);
    const requests = [options('d1-motion-duplicate-a'), options('d1-motion-duplicate-b')];
    const results = await Promise.allSettled(requests.map(opts => mutateSponsor(db, 'motions', null, input, opts)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
    assert.equal(await count(db, 'sponsorship_motions', 'contact_id=? AND campaign_id=?', [data.contact.id, data.campaign.id]), 1);
    const motion = results.find(result => result.status === 'fulfilled').value.body.item;
    assert.equal(await count(db, 'sponsorship_activities', 'motion_id=?', [motion.id]), 1);
    assert.equal(await count(db, 'audit_events', 'target_id=?', [motion.id]), 1);
    assert.equal(await count(db, 'sponsorship_mutation_receipts', 'idempotency_key IN (?,?)', requests.map(item => item.key)), 1);
  });

  await t.test('a late SQL failure rolls back commitment, activity, audit and receipt; same-key retry succeeds', async () => {
    const data = await records(db);
    const motion = (await mutateSponsor(db, 'motions', null, motionInput(data), options())).body.item;
    const input = { revision: 1, status: 'committed' }, opts = options('d1-failure-then-retry');
    const faultDb = {
      prepare: db.prepare.bind(db),
      batch(statements) {
        return db.batch([...statements, db.prepare("INSERT INTO sponsorship_write_guards (id,valid) VALUES ('injected-failure',0)")]);
      },
    };
    await assert.rejects(mutateSponsor(faultDb, 'motions', motion.id, input, opts), error => error.status === 409);
    assert.equal(await count(db, 'sponsorships', 'motion_id=?', [motion.id]), 0);
    assert.equal(await count(db, 'sponsorship_activities', 'motion_id=?', [motion.id]), 1);
    assert.equal(await count(db, 'audit_events', 'target_id=?', [motion.id]), 1);
    assert.equal(await count(db, 'sponsorship_mutation_receipts', 'idempotency_key=?', [opts.key]), 0);
    assert.equal((await getSponsorMotion(db, motion.id)).item.revision, 1);
    const success = await mutateSponsor(db, 'motions', motion.id, input, opts);
    // Simulate a committed result the client did not receive, then replay it.
    assert.deepEqual(await mutateSponsor(db, 'motions', motion.id, input, opts), success);
    assert.equal(await count(db, 'sponsorships', 'motion_id=?', [motion.id]), 1);
    assert.equal(await count(db, 'sponsorship_activities', 'motion_id=?', [motion.id]), 2);
    assert.equal(await count(db, 'audit_events', 'target_id=?', [motion.id]), 2);
    assert.equal(await count(db, 'sponsorship_mutation_receipts', 'idempotency_key=?', [opts.key]), 1);
    assert.equal(await count(db, 'sponsorship_write_guards'), 0);
  });

  await t.test('two edits that read the same revision cannot both commit', async () => {
    const { contact } = await records(db);
    let waiting = 0, release;
    const ready = new Promise(resolve => { release = resolve; });
    const gatedDb = {
      prepare: db.prepare.bind(db),
      async batch(statements) {
        if (++waiting === 2) release();
        await ready;
        return db.batch(statements);
      },
    };
    const requests = [options('d1-stale-edit-a'), options('d1-stale-edit-b')];
    const responses = await Promise.allSettled(requests.map((opts, index) => mutateSponsor(gatedDb, 'contacts', contact.id, { revision: 1, business_name: `Winner ${index}` }, opts)));
    const winner = responses.find(response => response.status === 'fulfilled').value;
    assert.equal(responses.filter(response => response.status === 'fulfilled').length, 1);
    assert.equal(responses.find(response => response.status === 'rejected').reason.status, 409);
    const current = await db.prepare('SELECT * FROM sponsor_contacts WHERE id=?').bind(contact.id).first();
    assert.equal(current.revision, 2);
    assert.equal(current.business_name, winner.body.item.business_name);
    assert.equal(await count(db, 'audit_events', "target_id=? AND action='sponsorship.contacts.update'", [contact.id]), 1);
    assert.equal(await count(db, 'sponsorship_mutation_receipts', 'idempotency_key IN (?,?)', requests.map(item => item.key)), 1);
    assert.equal(await count(db, 'sponsorship_write_guards'), 0);
  });

  await t.test('concurrent payment retries update aggregate received money exactly once', async () => {
    const data = await records(db);
    const motion = (await mutateSponsor(db, 'motions', null, motionInput(data, { status: 'committed' }), options())).body.item;
    const input = { revision: 1, committed_cents: 125000, received_cents: 125000, invoice_status: 'issued' }, opts = options('d1-payment-retry');
    const responses = await Promise.all(Array.from({ length: 3 }, () => mutateSponsor(db, 'commitment', motion.id, input, opts)));
    for (const response of responses) assert.deepEqual(response, responses[0]);
    const current = await getSponsorMotion(db, motion.id);
    assert.equal(current.item.status, 'paid');
    assert.equal(current.item.revision, 2);
    assert.equal(current.commitment.received_cents, 125000);
    assert.equal(current.commitment.invoice_status, 'paid');
    assert.equal(current.commitment.revision, 2);
    assert.equal(await count(db, 'sponsorships', 'motion_id=?', [motion.id]), 1);
    assert.equal(await count(db, 'sponsorship_activities', "motion_id=? AND type='commitment'", [motion.id]), 1);
    assert.equal(await count(db, 'sponsorship_mutation_receipts', 'idempotency_key=?', [opts.key]), 1);
  });
});
