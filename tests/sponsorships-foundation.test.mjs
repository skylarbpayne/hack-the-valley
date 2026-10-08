import assert from 'node:assert/strict';
import test from 'node:test';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';

async function seedRelationship(db) {
  await db.exec(`
    INSERT INTO sponsor_contacts (id,business_name,contact_name,created_at,updated_at)
      VALUES ('business','Example business','Jane Example','2026-09-24','2026-09-24');
    INSERT INTO sponsorship_campaigns (id,name,year,created_at,updated_at)
      VALUES ('campaign','HTV 2027',2027,'2026-09-24','2026-09-24'), ('campaign2','HTV 2028',2028,'2026-09-24','2026-09-24');
  `);
}

test('one contact can recur across campaigns, each motion has one owner and at most one commitment', async t => {
  const { db, close } = await createSponsorshipDb(); t.after(close);
  await seedRelationship(db);
  const add = (id, campaign, owner = DEMO_USERS.danny) => db.prepare(`INSERT INTO sponsorship_motions
    (id,contact_id,campaign_id,owner_user_id,created_at,updated_at) VALUES (?,'business',?,?,?,?)`).bind(id,campaign,owner,'2026-09-24','2026-09-24').run();
  await add('motion','campaign');
  await add('motion2','campaign2');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsorship_motions WHERE owner_user_id=?').bind(DEMO_USERS.danny).first()).n,2);
  await assert.rejects(add('duplicate','campaign'), /UNIQUE/);
  await assert.rejects(add('invalid-owner','campaign2','missing-user'), /FOREIGN KEY|UNIQUE/);
  await db.exec("INSERT INTO sponsorships (id,motion_id,created_at,updated_at) VALUES ('commitment','motion','2026-09-24','2026-09-24')");
  await assert.rejects(db.prepare("INSERT INTO sponsorships (id,motion_id,created_at,updated_at) VALUES ('duplicate','motion','2026-09-24','2026-09-24')").run(), /UNIQUE/);
  await assert.rejects(db.prepare("UPDATE sponsorships SET received_cents=-1 WHERE id='commitment'").run(), /CHECK/);
  await assert.rejects(db.prepare("UPDATE sponsorship_motions SET status='invalid' WHERE id='motion'").run(), /CHECK/);
});

test('optimistic write guard rolls back all related SQL when an edit is stale', async t => {
  const { db, close } = await createSponsorshipDb(); t.after(close);
  await seedRelationship(db);
  await assert.rejects(db.batch([
    db.prepare("UPDATE sponsor_contacts SET notes='must roll back' WHERE id='business'"),
    db.prepare("INSERT INTO sponsorship_write_guards (id,valid) VALUES ('stale',0)"),
  ]), /CHECK/);
  assert.equal((await db.prepare("SELECT notes FROM sponsor_contacts WHERE id='business'").first()).notes,null);
});

test('repeated fixture setup preserves edits, relative follow-ups and unique IDs', async t => {
  const { sponsorshipFixtureSql } = await import('../scripts/sponsorship-fixtures.mjs');
  const { db, close } = await createSponsorshipDb(); t.after(close);
  await db.exec(sponsorshipFixtureSql(new Date('2026-09-24T19:00:00Z')));
  const before = (await db.prepare('SELECT * FROM sponsorship_motions ORDER BY id').all()).results;
  await db.exec("UPDATE sponsor_contacts SET business_name='My edited business' WHERE id='sc_demo_01'");
  await db.exec(sponsorshipFixtureSql(new Date('2026-10-24T19:00:00Z')));
  assert.equal((await db.prepare("SELECT business_name FROM sponsor_contacts WHERE id='sc_demo_01'").first()).business_name,'My edited business');
  assert.deepEqual((await db.prepare('SELECT * FROM sponsorship_motions ORDER BY id').all()).results,before);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsor_contacts').first()).n,10);
  assert.equal(new Set(before.map(row => row.status)).size,8);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsorships').first()).n,5);
});

test('local launcher rejects remote targets and removes external integration credentials', async () => {
  const { parseCommand, localEnvironment, localConfig } = await import('../scripts/sponsorships-local.mjs');
  assert.throws(() => parseCommand(['setup','--remote']), /local|Unknown/);
  assert.throws(() => parseCommand(['reset','/tmp/other-store']), /local|Unknown/);
  const env = localEnvironment({ PATH:'/bin',HOME:'/home/demo',RESEND_API_KEY:'never-use',CLOUDFLARE_API_TOKEN:'never-use',HTV_ADMIN_TOKEN:'never-use' });
  assert.equal(env.PATH,'/bin');
  assert.equal(env.RESEND_API_KEY,undefined);
  assert.equal(env.CLOUDFLARE_API_TOKEN,undefined);
  const config = localConfig('/project');
  assert.equal(config.vars.SPONSORSHIP_REMINDERS_MODE,'preview');
  assert.equal(config.vars.HTV_AUTH_DEV_MODE,'local');
  assert.equal(config.d1_databases[0].remote,false);
  assert.equal(config.r2_buckets[0].remote,false);
});
