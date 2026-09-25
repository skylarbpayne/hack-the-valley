import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContact, validateMotion, normalizeCommitment, mutateSponsor, listSponsorRecords, getSponsorMotion, addSponsorActivity } from '../functions/_lib/domain/sponsorships.js';

test('contact validation requires a business and validates optional email', () => {
  assert.throws(() => validateContact({ business_name: '' }), /business/i);
  assert.throws(() => validateContact({ business_name: 'Acme', email: 'invalid' }), /email/i);
  assert.equal(validateContact({ business_name: ' Acme ', email: '' }).business_name, 'Acme');
});
test('motion validation checks status and real calendar dates', () => {
  assert.throws(() => validateMotion({ contact_id:'c',campaign_id:'p',owner_user_id:'u',status:'made_up' }), /status/i);
  assert.throws(() => validateMotion({ contact_id:'c',campaign_id:'p',owner_user_id:'u',follow_up_on:'2026-02-30' }), /date/i);
});
test('payment normalization uses nonnegative integer cents and coherent invoice status', () => {
  assert.throws(() => normalizeCommitment({committed_cents:-1}), /amount|cents/i);
  assert.throws(() => normalizeCommitment({received_cents:1.1}), /amount|cents/i);
  assert.equal(normalizeCommitment({contribution_type:'cash',committed_cents:10000,received_cents:10000,invoice_status:'issued'}).invoice_status,'paid');
  assert.equal(normalizeCommitment({contribution_type:'cash',committed_cents:10000,received_cents:100,invoice_status:'paid'}).invoice_status,'issued');
  assert.throws(() => normalizeCommitment({contribution_type:'in_kind',received_cents:100}), /in.kind/i);
});

import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';
const actorUserId = DEMO_USERS.danny;
let seq = 0;
const options = () => ({actorUserId,key:`test-operation-${++seq}`});
async function fixtures(t) {
  const {db,close} = await createSponsorshipDb(); t.after(close);
  const contact = (await mutateSponsor(db,'contacts',null,{business_name:'Acme'},options())).body.item;
  const campaign = (await mutateSponsor(db,'campaigns',null,{name:'HTV 2027',year:2027},options())).body.item;
  return {db,contact,campaign};
}
async function createMotion(db,contact,campaign,extra={}) {
  return (await mutateSponsor(db,'motions',null,{contact_id:contact.id,campaign_id:campaign.id,owner_user_id:actorUserId,...extra},options())).body.item;
}
test('retry returns original success after a lost response; changed payload conflicts', async t => {
  const {db} = await fixtures(t), opts=options(), input={business_name:'Retry business'};
  const first=await mutateSponsor(db,'contacts',null,input,opts);
  const again=await mutateSponsor(db,'contacts',null,input,opts);
  assert.deepEqual(again,first);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sponsor_contacts WHERE business_name='Retry business'").first()).n,1);
  await assert.rejects(mutateSponsor(db,'contacts',null,{business_name:'Changed'},opts), e=>e.status===409);
});
test('simultaneous duplicate operations create one record and one audit entry', async t => {
  const {db}=await fixtures(t), opts=options(), input={business_name:'Concurrent business'};
  const results=await Promise.all([mutateSponsor(db,'contacts',null,input,opts),mutateSponsor(db,'contacts',null,input,opts)]);
  assert.deepEqual(results[0],results[1]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE target_id=?').bind(results[0].body.item.id).first()).n,1);
});
test('same-key update replays when a competing request commits between receipt and revision reads', async t => {
  const {db,contact}=await fixtures(t), opts=options();
  const input={revision:contact.revision,business_name:'Concurrent edit'};
  let releaseReceipt,receiptRead;
  const pausedReceipt=new Promise(resolve=>{releaseReceipt=resolve;});
  const receiptWasRead=new Promise(resolve=>{receiptRead=resolve;});
  let intercept=true;
  const delayedDb={...db,prepare(sql){
    const statement=db.prepare(sql);
    if(intercept && sql.includes('SELECT * FROM sponsorship_mutation_receipts')) {
      intercept=false;
      return {bind(...args){
        const bound=statement.bind(...args);
        return {...bound,async first(){
          const row=await bound.first();
          receiptRead(); await pausedReceipt;
          return row;
        }};
      }};
    }
    return statement;
  }};
  const pending=mutateSponsor(delayedDb,'contacts',contact.id,input,opts);
  await receiptWasRead;
  const winner=await mutateSponsor(db,'contacts',contact.id,input,opts);
  releaseReceipt();
  assert.deepEqual(await pending,winner);
  assert.equal((await db.prepare('SELECT revision FROM sponsor_contacts WHERE id=?').bind(contact.id).first()).revision,2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE target_id=? AND action='sponsorship.contacts.update'").bind(contact.id).first()).n,1);
});
test('concurrent replay returns committed success even if its referenced owner has since lost access', async t=>{
  const {db,contact,campaign}=await fixtures(t),opts=options();
  const input={contact_id:contact.id,campaign_id:campaign.id,owner_user_id:DEMO_USERS.alex};
  let releaseReceipt,receiptRead,intercept=true;
  const paused=new Promise(resolve=>{releaseReceipt=resolve;});
  const read=new Promise(resolve=>{receiptRead=resolve;});
  const delayedDb={...db,prepare(sql){
    const statement=db.prepare(sql);
    if(intercept && sql.includes('SELECT * FROM sponsorship_mutation_receipts')){
      intercept=false;
      return {bind(...args){const bound=statement.bind(...args);return {...bound,async first(){
        const row=await bound.first();receiptRead();await paused;return row;
      }};}};
    }
    return statement;
  }};
  const pending=mutateSponsor(delayedDb,'motions',null,input,opts);
  await read;
  const winner=await mutateSponsor(db,'motions',null,input,opts);
  await db.prepare('UPDATE roles SET revoked_at=? WHERE user_id=?').bind(new Date().toISOString(),DEMO_USERS.alex).run();
  releaseReceipt();
  assert.deepEqual(await pending,winner);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsorship_motions').first()).n,1);
});
test('motion uniqueness and one user owning many motions, across campaigns', async t => {
  const {db,contact,campaign}=await fixtures(t);
  const motion=await createMotion(db,contact,campaign);
  await assert.rejects(createMotion(db,contact,campaign), e=>e.status===409);
  const next=(await mutateSponsor(db,'campaigns',null,{name:'Next year',year:2028},options())).body.item;
  await createMotion(db,contact,next);
  assert.equal((await listSponsorRecords(db,'motions',{owner_user_id:actorUserId})).count,2);
  assert.equal((await getSponsorMotion(db,motion.id)).item.status,'not_contacted');
  await assert.rejects(mutateSponsor(db,'motions',motion.id,{revision:motion.revision,owner_user_id:DEMO_USERS.member},options()),/admin/i);
});
test('stale writes roll back side effects while replay succeeds despite newer revision', async t => {
  const {db,contact}=await fixtures(t), opts=options();
  const input={revision:contact.revision,business_name:'Updated'};
  const result=await mutateSponsor(db,'contacts',contact.id,input,opts);
  assert.equal(result.body.item.revision,2);
  assert.deepEqual(await mutateSponsor(db,'contacts',contact.id,input,opts),result);
  await assert.rejects(mutateSponsor(db,'contacts',contact.id,{revision:1,business_name:'Lost update'},options()),e=>e.status===409);
  assert.equal((await db.prepare('SELECT business_name FROM sponsor_contacts WHERE id=?').bind(contact.id).first()).business_name,'Updated');
});
test('commitments are unique and payment totals drive status without double counting', async t => {
  const {db,contact,campaign}=await fixtures(t);
  let motion=await createMotion(db,contact,campaign,{status:'committed'});
  let detail=await getSponsorMotion(db,motion.id);
  assert.ok(detail.commitment);
  assert.equal(detail.item.status,'committed');
  const opts=options(), input={revision:1,committed_cents:50000,received_cents:10000,invoice_status:'issued'};
  const partial=await mutateSponsor(db,'commitment',motion.id,input,opts);
  assert.deepEqual(await mutateSponsor(db,'commitment',motion.id,input,opts),partial);
  assert.equal((await getSponsorMotion(db,motion.id)).item.status,'committed');
  await mutateSponsor(db,'commitment',motion.id,{revision:2,received_cents:50000},options());
  detail=await getSponsorMotion(db,motion.id);
  assert.equal(detail.item.status,'paid'); assert.equal(detail.commitment.invoice_status,'paid');
  await mutateSponsor(db,'commitment',motion.id,{revision:3,received_cents:100},options());
  detail=await getSponsorMotion(db,motion.id);
  assert.equal(detail.item.status,'committed'); assert.equal(detail.commitment.invoice_status,'issued');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsorships').first()).n,1);
});
test('follow-up completion and rescheduling preserves history and clears completion', async t=>{
  const {db,contact,campaign}=await fixtures(t);
  let motion=await createMotion(db,contact,campaign,{status:'followup',next_action:'Call',follow_up_on:'2020-01-01'});
  motion=(await mutateSponsor(db,'motions',motion.id,{revision:1,follow_up_completed_at:'2026-09-24T18:00:00Z'},options())).body.item;
  assert.ok(motion.follow_up_completed_at);
  motion=(await mutateSponsor(db,'motions',motion.id,{revision:2,follow_up_on:'2026-10-01',next_action:'Send proposal'},options())).body.item;
  assert.equal(motion.follow_up_completed_at,null);
  assert.ok((await getSponsorMotion(db,motion.id)).activities.length>=3);
});

test('activity writes reject a null body with a validation error and no side effects', async t=>{
  const {db,contact,campaign}=await fixtures(t);
  const motion=await createMotion(db,contact,campaign);
  await assert.rejects(addSponsorActivity(db,motion.id,null,options()),error=>error.status===400);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsorship_activities WHERE motion_id=?').bind(motion.id).first()).n,1);
});

function pauseNextBatch(db) {
  let release,arrived,intercept=true;
  const pause=new Promise(resolve=>{release=resolve;});
  const waiting=new Promise(resolve=>{arrived=resolve;});
  return { release,waiting,db:{...db,async batch(statements){
    if(intercept){intercept=false;arrived();await pause;}
    return db.batch(statements);
  }}};
}

test('concurrent payment settlement and status changes cannot overwrite each other', async t => {
  for(const delayedOperation of ['payment','status']) await t.test(`delayed ${delayedOperation}`,async t=>{
    const {db,contact,campaign}=await fixtures(t);
    const motion=await createMotion(db,contact,campaign,{status:'committed'});
    await mutateSponsor(db,'commitment',motion.id,{revision:1,committed_cents:10000},options());
    const gated=pauseNextBatch(db),opts=options();
    const pending=delayedOperation==='payment'
      ? mutateSponsor(gated.db,'commitment',motion.id,{revision:2,received_cents:10000},opts)
      : mutateSponsor(gated.db,'motions',motion.id,{revision:2,status:'lost'},opts);
    await gated.waiting;
    if(delayedOperation==='payment') await mutateSponsor(db,'motions',motion.id,{revision:2,status:'lost'},options());
    else await mutateSponsor(db,'commitment',motion.id,{revision:2,received_cents:10000},options());
    gated.release();
    await assert.rejects(pending,e=>e.status===409);
    const detail=await getSponsorMotion(db,motion.id);
    assert.equal(detail.item.status,delayedOperation==='payment'?'lost':'paid');
    assert.equal(detail.commitment.received_cents,delayedOperation==='payment'?0:10000);
    assert.equal(detail.activities.length,3);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsorship_mutation_receipts WHERE idempotency_key=?').bind(opts.key).first()).n,0);
  });
});

test('owner revocation before creation commits prevents assigning an inactive owner', async t => {
  const {db,contact,campaign}=await fixtures(t),gated=pauseNextBatch(db);
  const pending=mutateSponsor(gated.db,'motions',null,{
    contact_id:contact.id,campaign_id:campaign.id,owner_user_id:DEMO_USERS.alex,
  },options());
  await gated.waiting;
  await db.prepare('UPDATE roles SET revoked_at=? WHERE user_id=?').bind(new Date().toISOString(),DEMO_USERS.alex).run();
  gated.release();
  await assert.rejects(pending,e=>e.status===409);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsorship_motions').first()).n,0);
});

test('campaign archival before creation commits prevents adding a prospect to a closed campaign', async t => {
  const {db,contact,campaign}=await fixtures(t),gated=pauseNextBatch(db);
  const pending=createMotion(gated.db,contact,campaign);
  await gated.waiting;
  await mutateSponsor(db,'campaigns',campaign.id,{revision:campaign.revision,archived_at:new Date().toISOString()},options());
  gated.release();
  await assert.rejects(pending,e=>e.status===409);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsorship_motions').first()).n,0);
});

test('a failed commitment transition rolls back motion, sponsorship, activity, audit, and receipt before retry', async t=>{
  const {db,contact,campaign}=await fixtures(t),motion=await createMotion(db,contact,campaign);
  const input={revision:motion.revision,status:'committed'},opts=options();
  const initialAudits=(await db.prepare('SELECT COUNT(*) AS n FROM audit_events').first()).n;
  await db.exec(`CREATE TRIGGER fail_sponsorship_audit BEFORE INSERT ON audit_events
    BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END`);
  await assert.rejects(mutateSponsor(db,'motions',motion.id,input,opts),/simulated audit failure/);
  let detail=await getSponsorMotion(db,motion.id);
  assert.equal(detail.item.status,'not_contacted');
  assert.equal(detail.item.revision,1);
  assert.equal(detail.commitment,null);
  assert.equal(detail.activities.length,1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM audit_events').first()).n,initialAudits);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sponsorship_mutation_receipts WHERE idempotency_key=?').bind(opts.key).first()).n,0);
  await db.exec('DROP TRIGGER fail_sponsorship_audit');
  const result=await mutateSponsor(db,'motions',motion.id,input,opts);
  assert.deepEqual(await mutateSponsor(db,'motions',motion.id,input,opts),result);
  detail=await getSponsorMotion(db,motion.id);
  assert.equal(detail.item.status,'committed');
  assert.ok(detail.commitment);
  assert.equal(detail.activities.length,2);
});

test('sponsorship review lists the saved in-kind description',async t=>{
 const {db,contact,campaign}=await fixtures(t);
 const motion=await createMotion(db,contact,campaign,{status:'committed'});
 await mutateSponsor(db,'commitment',motion.id,{revision:1,contribution_type:'in_kind',in_kind_description:'Lunch for 50 students'},options());
 const list=await listSponsorRecords(db,'motions',{});
 assert.equal(list.items[0].in_kind_description,'Lunch for 50 students');
});
