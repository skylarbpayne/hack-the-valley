import test from 'node:test';
import assert from 'node:assert/strict';
import {createSponsorshipDb,DEMO_USERS} from './helpers/sponsorship-db.mjs';
import {mutateSponsor,getSponsorMotion} from '../functions/_lib/domain/sponsorships.js';
import {uploadSponsorLogo,getSponsorLogo} from '../functions/_lib/domain/sponsorship-logos.js';
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=','base64'));
const opts=()=>({actorUserId:DEMO_USERS.danny,key:crypto.randomUUID()});
function request(revision=1,bytes=png,type='image/png') {return new Request('http://localhost/logo',{method:'POST',headers:{'Content-Type':type,'X-Filename':'brand.png','X-Revision':String(revision)},body:bytes});}
async function fixture(t){
 const {db,close}=await createSponsorshipDb();t.after(close);
 const contact=(await mutateSponsor(db,'contacts',null,{business_name:'Logo business'},opts())).body.item;
 const campaign=(await mutateSponsor(db,'campaigns',null,{name:'HTV',year:2027},opts())).body.item;
 const motion=(await mutateSponsor(db,'motions',null,{contact_id:contact.id,campaign_id:campaign.id,owner_user_id:DEMO_USERS.danny,status:'committed'},opts())).body.item;
 const objects=new Map(); const bucket={async put(key,body,metadata){objects.set(key,{body,metadata});},async get(key){const o=objects.get(key);return o?{body:o.body,httpMetadata:o.metadata.httpMetadata}:null;},async delete(key){objects.delete(key);}};
 return {db,motion,bucket,objects};
}
test('logo upload is private, replayable and replacement updates one reference',async t=>{
 const {db,motion,bucket,objects}=await fixture(t),o=opts();
 const first=await uploadSponsorLogo(db,bucket,motion.id,request(),o);
 assert.deepEqual(await uploadSponsorLogo(db,bucket,motion.id,request(),o),first);
 assert.equal(objects.size,1);
 assert.equal((await getSponsorLogo(db,bucket,motion.id)).headers.get('Cache-Control'),'no-store');
 await uploadSponsorLogo(db,bucket,motion.id,request(2),opts());
 assert.equal(objects.size,1);
 assert.equal((await getSponsorMotion(db,motion.id)).commitment.revision,3);
});
test('upload validates bytes and rejects malformed/type/size data',async t=>{
 const {db,motion,bucket}=await fixture(t);
 await assert.rejects(uploadSponsorLogo(db,bucket,motion.id,request(1,new Uint8Array([1,2,3])),opts()),/image|PNG|signature/i);
 await assert.rejects(uploadSponsorLogo(db,bucket,motion.id,request(1,png,'image/svg+xml'),opts()),/type|PNG|JPEG|WebP/i);
 await assert.rejects(uploadSponsorLogo(db,bucket,motion.id,request(1,new Uint8Array(5*1024*1024+1)),opts()),/large|5 MB/i);
});
test('failed metadata write preserves old logo and permits retry',async t=>{
 const {db,motion,bucket,objects}=await fixture(t);
 await uploadSponsorLogo(db,bucket,motion.id,request(),opts());
 const old=(await getSponsorMotion(db,motion.id)).commitment.logo_storage_key;
 const realBatch=db.batch.bind(db);db.batch=async()=>{throw new Error('Injected write failure');};const o=opts();
 await assert.rejects(uploadSponsorLogo(db,bucket,motion.id,request(2),o),/Injected/);
 assert.ok(objects.has(old));assert.equal(objects.size,2,'failed replacement is retained for a concurrent or later retry');
 db.batch=realBatch;
 await uploadSponsorLogo(db,bucket,motion.id,request(2),o);
 assert.equal(objects.size,1);
});

test('one failed request cannot delete the logo referenced by a concurrent same-key success',async t=>{
 const {db,motion,bucket,objects}=await fixture(t);
 await uploadSponsorLogo(db,bucket,motion.id,request(),opts());
 const original=(await getSponsorMotion(db,motion.id)).commitment.logo_storage_key;
 const sameOperation=opts();
 let failedBatchReached,successfulBatchReached,allowSuccessfulBatch;
 const failedReady=new Promise(resolve=>{failedBatchReached=resolve;});
 const successReady=new Promise(resolve=>{successfulBatchReached=resolve;});
 const successGate=new Promise(resolve=>{allowSuccessfulBatch=resolve;});
 const failingDb={prepare:db.prepare.bind(db),async batch(){failedBatchReached();await successReady;throw new Error('Injected concurrent metadata failure');}};
 const waitingDb={prepare:db.prepare.bind(db),async batch(statements){successfulBatchReached();await successGate;return db.batch(statements);}};
 const failing=uploadSponsorLogo(failingDb,bucket,motion.id,request(2),sameOperation);
 await failedReady;
 const succeeding=uploadSponsorLogo(waitingDb,bucket,motion.id,request(2),sameOperation);
 await assert.rejects(failing,/Injected concurrent/);
 assert.ok(objects.has(original),'the current logo remains during the failed request');
 allowSuccessfulBatch();
 const response=await succeeding;
 assert.ok(objects.has(response.body.item.logo_storage_key),'the successful metadata reference must still have its object');
 assert.equal(objects.size,1);
 assert.deepEqual(await uploadSponsorLogo(db,bucket,motion.id,request(2),sameOperation),response);
});
