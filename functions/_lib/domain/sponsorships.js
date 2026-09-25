import { parseWithSchema, schema } from './shared.js';

export const SPONSOR_STATUSES = ['not_contacted','contacted','followup','interest','negotiating','lost','committed','paid'];
export function sponsorError(message, status = 400) { return Object.assign(new Error(message), {status}); }
const trim = (v, max = 2000) => { const s = String(v ?? '').trim(); if (s.length > max) throw sponsorError(`Text exceeds ${max} characters`); return s; };
function pick(value, options, label) { if (!options.includes(value)) throw sponsorError(`Invalid ${label}`); return value; }
function date(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw sponsorError('Invalid follow-up date');
  return value;
}
function timestamp(value) {
  if (!value) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw sponsorError('Invalid timestamp');
  return new Date(value).toISOString();
}
function cents(value, nullable = false) {
  if (nullable && (value == null || value === '')) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_00) throw sponsorError('Amounts must be nonnegative integer cents');
  return value;
}
function required(value, name) { const s = trim(value, 250); if (!s) throw sponsorError(`${name} is required`); return s; }
export function validateContact(input) {
  const email = trim(input.email, 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw sponsorError('Invalid contact email');
  const website = trim(input.website, 1000);
  if (website && !/^https?:\/\//i.test(website)) throw sponsorError('Website must begin with http:// or https://');
  return {business_name:required(input.business_name, 'Business name'), contact_name:trim(input.contact_name,250),email,phone:trim(input.phone,100),website,notes:trim(input.notes,10000)};
}
export function validateCampaign(input) {
  const year = Number(input.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw sponsorError('Campaign year must be between 2000 and 2200');
  return {name:required(input.name,'Campaign name'),year,purpose:trim(input.purpose,2000),event_instance_id:trim(input.event_instance_id,250)||null,archived_at:timestamp(input.archived_at)};
}
export function validateMotion(input) {
  return {contact_id:required(input.contact_id,'Contact'),campaign_id:required(input.campaign_id,'Campaign'),owner_user_id:required(input.owner_user_id,'Owner'),status:pick(input.status || 'not_contacted',SPONSOR_STATUSES,'status'),notes:trim(input.notes,10000),next_action:trim(input.next_action,2000),follow_up_on:date(input.follow_up_on),follow_up_completed_at:timestamp(input.follow_up_completed_at)};
}
export function normalizeCommitment(input) {
  const contribution_type = pick(input.contribution_type || 'cash',['cash','in_kind','both'],'contribution type');
  const committed_cents = cents(input.committed_cents,true), received_cents = cents(input.received_cents ?? 0);
  if (contribution_type === 'in_kind' && ((committed_cents ?? 0) > 0 || received_cents > 0)) throw sponsorError('In-kind-only sponsorships cannot have cash amounts');
  let invoice_status = pick(input.invoice_status || 'not_issued',['not_issued','issued','paid'],'invoice status');
  const paid = contribution_type !== 'in_kind' && committed_cents > 0 && received_cents >= committed_cents;
  if (invoice_status !== 'not_issued') invoice_status = paid ? 'paid' : 'issued';
  return {contribution_type,committed_cents,received_cents,currency:'USD',in_kind_description:trim(input.in_kind_description,10000),fulfilled_at:timestamp(input.fulfilled_at),payment_method:input.payment_method ? pick(input.payment_method,['check','bank_transfer','cash','other'],'payment method'):null,check_reference:trim(input.check_reference,250),invoice_number:trim(input.invoice_number,250),invoice_status};
}
export function paymentStatus(commitment) { return commitment.contribution_type !== 'in_kind' && commitment.committed_cents > 0 && commitment.received_cents >= commitment.committed_cents ? 'paid' : 'committed'; }
export function validateInputObject(input) { return parseWithSchema(schema.record(schema.string(), schema.unknown()), input); }

const TABLES = {contacts:'sponsor_contacts',campaigns:'sponsorship_campaigns',motions:'sponsorship_motions',commitment:'sponsorships'};
const id = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-','')}`;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
export async function sponsorHash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join(''); }
export async function mutationContext(db, operation, input, {actorUserId,key}) {
  if (!actorUserId) throw sponsorError('A signed-in admin is required',403);
  if (typeof key !== 'string' || !/^[\w.:-]{8,150}$/.test(key)) throw sponsorError('A valid Idempotency-Key is required');
  const fingerprint = await sponsorHash(canonical(input));
  const context={actorUserId,key,operation,fingerprint};
  return {...context,replay:await replayMutation(db,context)};
}
async function replayMutation(db,c) {
  const row=await db.prepare('SELECT * FROM sponsorship_mutation_receipts WHERE actor_user_id=? AND operation=? AND idempotency_key=?').bind(c.actorUserId,c.operation,c.key).first();
  if (!row) return null;
  if (row.fingerprint!==c.fingerprint) throw sponsorError('This request key was already used with different data. Start a new save.',409);
  return {status:row.response_status,body:JSON.parse(row.response_json)};
}
function insert(db,table,row) {
  const keys=Object.keys(row); return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...keys.map(k=>row[k]));
}
function revisionGuard(db,table,rowId,revision,guardId=id('guard')) {
  if (!Number.isInteger(revision) || revision<1) throw sponsorError('The current revision is required',409);
  return [db.prepare(`INSERT INTO sponsorship_write_guards (id,valid) VALUES (?,(SELECT COUNT(*) FROM ${table} WHERE id=? AND revision=?))`).bind(guardId,rowId,revision),db.prepare('DELETE FROM sponsorship_write_guards WHERE id=?').bind(guardId)];
}
function existenceGuard(db,query,params) {
  const guardId=id('guard');
  return [db.prepare(`INSERT INTO sponsorship_write_guards (id,valid) VALUES (?,EXISTS(${query}))`).bind(guardId,...params),db.prepare('DELETE FROM sponsorship_write_guards WHERE id=?').bind(guardId)];
}
function update(db,table,row,oldRevision) {
  const keys=Object.keys(row).filter(k=>k!=='id');
  return db.prepare(`UPDATE ${table} SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=? AND revision=?`).bind(...keys.map(k=>row[k]),row.id,oldRevision);
}
function auditStatement(db,{actorUserId,operation,targetId,now}) {
  return insert(db,'audit_events',{id:id('audit'),action:`sponsorship.${operation}`,actor_user_id:actorUserId,target_type:'sponsorship',target_id:targetId,scope_type:'sponsorship',scope_id:targetId,metadata_json:JSON.stringify({source:'admin-sponsorships'}),created_at:now});
}
function activityStatement(db,motionId,actor,type,description,now) {
  const item={id:id('sact'),motion_id:motionId,actor_user_id:actor,type,description,created_at:now};
  return {item,statement:insert(db,'sponsorship_activities',item)};
}
export async function commitMutation(db,c,statements,result,now=new Date().toISOString()) {
  statements.push(insert(db,'sponsorship_mutation_receipts',{actor_user_id:c.actorUserId,operation:c.operation,idempotency_key:c.key,fingerprint:c.fingerprint,response_status:result.status,response_json:JSON.stringify(result.body),created_at:now}));
  try { await db.batch(statements); return result; }
  catch (error) {
    // A competing replay may have completed while this transaction rolled back.
    const replay=await replayMutation(db,c); if(replay) return replay;
    if (/UNIQUE constraint|CHECK constraint|sponsorship_write_guards/i.test(error.message)) throw sponsorError('Record changed or already exists. Refresh and review your draft.',409);
    if (/FOREIGN KEY/i.test(error.message)) throw sponsorError('A referenced record no longer exists',400);
    throw error;
  }
}
async function getRow(db,resource,rowId) {
  const table=TABLES[resource]; if(!table) throw sponsorError('Unknown sponsorship resource',404);
  const row=await db.prepare(`SELECT * FROM ${table} WHERE ${resource==='commitment'?'motion_id':'id'}=?`).bind(rowId).first();
  if(!row) throw sponsorError('Record not found',404); return row;
}
export async function listSponsorOwners(db) {
  return (await db.prepare("SELECT u.id,u.name,u.email FROM users u WHERE EXISTS (SELECT 1 FROM roles r WHERE r.user_id=u.id AND r.scope_type='global' AND r.scope_id='*' AND r.role IN ('admin','super_admin') AND r.revoked_at IS NULL) ORDER BY u.name,u.email").all()).results;
}
async function checkOwner(db,userId) {
  if (!(await listSponsorOwners(db)).some(u=>u.id===userId)) throw sponsorError('Owner must be an active global admin');
}
export async function mutateSponsor(db,resource,rowId,input,options) {
  validateInputObject(input);
  const c=await mutationContext(db,`${resource}:${rowId || 'create'}`,input,options); if(c.replay) return c.replay;
  try { return await applySponsorMutation(db,resource,rowId,input,c); }
  catch(error) {
    // A matching request can commit after the initial receipt read, before
    // revision or relationship validation. Preserve its successful response
    // even when that commit (or a later edit) changed the current state.
    const replay=await replayMutation(db,c); if(replay) return replay;
    throw error;
  }
}
async function applySponsorMutation(db,resource,rowId,input,c) {
  const table=TABLES[resource]; if(!table) throw sponsorError('Unknown resource',404);
  const previous=rowId?await getRow(db,resource,rowId):null;
  if(previous && input.revision!==previous.revision) throw sponsorError('Record changed. Refresh and review your draft.',409);
  if(resource==='commitment' && !previous) throw sponsorError('Mark the motion Committed first');
  let values={...previous,...input};
  if(resource==='contacts') values=validateContact(values);
  if(resource==='campaigns') {
    values=validateCampaign(values);
    if(values.event_instance_id && !await db.prepare('SELECT id FROM event_instances WHERE id=?').bind(values.event_instance_id).first()) throw sponsorError('Event instance not found');
  }
  let linked=null, parent=null;
  if(resource==='motions') {
    values=validateMotion(values);
    if(!previous || values.owner_user_id!==previous.owner_user_id) await checkOwner(db,values.owner_user_id);
    if(previous && (values.contact_id!==previous.contact_id || values.campaign_id!==previous.campaign_id)) throw sponsorError('Create a new motion to change the contact or campaign');
    const campaign=await getRow(db,'campaigns',values.campaign_id);
    await getRow(db,'contacts',values.contact_id);
    if(!previous && campaign.archived_at) throw sponsorError('Choose an active campaign');
    if(previous && (values.follow_up_on!==previous.follow_up_on || values.next_action!==previous.next_action)) values.follow_up_completed_at=null;
    linked=previous ? await db.prepare('SELECT * FROM sponsorships WHERE motion_id=?').bind(rowId).first() : null;
    if(values.status==='paid' && (!linked || paymentStatus(linked)!=='paid')) throw sponsorError('Record full cash payment before marking Paid');
    if(values.status==='committed' && linked) values.status=paymentStatus(linked);
  }
  if(resource==='commitment') { values=normalizeCommitment(values); parent=await getRow(db,'motions',rowId); }
  const now=new Date().toISOString();
  const row={...(previous||{}),...values,id:previous?.id || id(resource==='contacts'?'sco':resource==='campaigns'?'sca':'smo'),revision:(previous?.revision||0)+1,created_at:previous?.created_at||now,updated_at:now,created_by_user_id:previous?.created_by_user_id||c.actorUserId,updated_by_user_id:c.actorUserId};
  const statements=[];
  if(resource==='motions') {
    // Role and campaign state can change after the helpful validation reads.
    // Recheck only creation/reassignment invariants inside the write batch;
    // historical motions remain editable when an existing owner loses access.
    if(!previous || row.owner_user_id!==previous.owner_user_id) statements.push(...existenceGuard(db,
      "SELECT 1 FROM roles WHERE user_id=? AND role IN ('admin','super_admin') AND scope_type='global' AND scope_id='*' AND revoked_at IS NULL",[row.owner_user_id]));
    if(!previous) statements.push(...existenceGuard(db,
      'SELECT 1 FROM sponsorship_campaigns WHERE id=? AND archived_at IS NULL',[row.campaign_id]));
  }
  if(previous) { statements.push(...revisionGuard(db,table,previous.id,input.revision),update(db,table,row,input.revision)); }
  else statements.push(insert(db,table,row));
  if(resource==='motions') {
    if(row.status==='committed' && !linked) statements.push(insert(db,'sponsorships',{id:id('spo'),motion_id:row.id,...normalizeCommitment({}),revision:1,created_at:now,updated_at:now,created_by_user_id:c.actorUserId,updated_by_user_id:c.actorUserId}));
    const description=previous ? `Updated outreach${previous.status!==row.status?`: ${previous.status} → ${row.status}`:''}${!previous.follow_up_completed_at && row.follow_up_completed_at?'; follow-up completed':''}` : `Added prospect (${row.status})`;
    statements.push(activityStatement(db,row.id,c.actorUserId,'update',description,now).statement);
  }
  if(resource==='commitment') {
    // Guard the parent too: payment and owner/status edits must not race.
    statements.push(...revisionGuard(db,'sponsorship_motions',parent.id,parent.revision));
    const status=['committed','paid'].includes(parent.status)?paymentStatus(row):parent.status;
    statements.push(db.prepare('UPDATE sponsorship_motions SET status=?,revision=revision+1,updated_at=?,updated_by_user_id=? WHERE id=? AND revision=?').bind(status,now,c.actorUserId,parent.id,parent.revision));
    statements.push(activityStatement(db,parent.id,c.actorUserId,'commitment',`Updated commitment; cash received $${(row.received_cents/100).toFixed(2)}`,now).statement);
  }
  statements.push(auditStatement(db,{actorUserId:c.actorUserId,operation:`${resource}.${previous?'update':'create'}`,targetId:row.id,now}));
  return commitMutation(db,c,statements,{status:previous?200:201,body:{ok:true,item:row}},now);
}
const JOINED_MOTIONS=`SELECT m.*,c.business_name,c.contact_name,c.email,u.name AS owner_name,u.email AS owner_email,p.name AS campaign_name,p.archived_at AS campaign_archived_at,
  s.id AS sponsorship_id,s.contribution_type,s.committed_cents,s.received_cents,s.fulfilled_at,s.logo_storage_key,s.in_kind_description,
  EXISTS(SELECT 1 FROM roles r WHERE r.user_id=m.owner_user_id AND r.scope_type='global' AND r.scope_id='*' AND r.role IN ('admin','super_admin') AND r.revoked_at IS NULL) AS owner_active,
  (SELECT a.description FROM sponsorship_activities a WHERE a.motion_id=m.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS latest_activity
  FROM sponsorship_motions m JOIN sponsor_contacts c ON c.id=m.contact_id JOIN sponsorship_campaigns p ON p.id=m.campaign_id JOIN users u ON u.id=m.owner_user_id LEFT JOIN sponsorships s ON s.motion_id=m.id`;
async function projectMotion(row) {
  const {isOverdue,pacificDate}=await import('./sponsorship-reminders.js');
  return {...row,owner_active:!!row.owner_active,overdue:isOverdue(row,pacificDate(new Date())),logo_url:row.logo_storage_key?`/api/admin/sponsorships/motions/${encodeURIComponent(row.id)}/logo`:null};
}
export async function listSponsorRecords(db,resource,filters={}) {
  if(!['contacts','campaigns','motions'].includes(resource)) throw sponsorError('Unknown resource',404);
  const params=[],clauses=[];
  if(resource==='motions') {
    for(const field of ['campaign_id','owner_user_id','status']) if(filters[field]){clauses.push(`m.${field}=?`);params.push(filters[field]);}
    if(filters.overdue==='1' || filters.overdue===true) {
      const {pacificDate}=await import('./sponsorship-reminders.js');
      clauses.push("m.follow_up_on < ? AND m.follow_up_completed_at IS NULL AND m.status NOT IN ('lost','paid') AND p.archived_at IS NULL");params.push(pacificDate(new Date()));
    }
  }
  if(filters.q) { const field=resource==='contacts'?'business_name':resource==='campaigns'?'name':'c.business_name';clauses.push(`${field} LIKE ?`);params.push(`%${trim(filters.q,250)}%`); }
  const base=resource==='motions'?JOINED_MOTIONS:`SELECT * FROM ${TABLES[resource]}`;
  const where=clauses.length?` WHERE ${clauses.join(' AND ')}`:'';
  const count=(await db.prepare(`SELECT COUNT(*) AS n FROM (${base}${where})`).bind(...params).first()).n;
  const limit=Math.max(1,Math.min(100,Number.parseInt(filters.limit)||100)),offset=Math.max(0,Number.parseInt(filters.offset)||0);
  const order=resource==='contacts'?'business_name COLLATE NOCASE':resource==='campaigns'?'year DESC,name':'m.updated_at DESC,m.id';
  const rows=(await db.prepare(`${base}${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...params,limit,offset).all()).results;
  return {ok:true,items:resource==='motions'?await Promise.all(rows.map(projectMotion)):rows,count};
}
export async function getSponsorMotion(db,motionId) {
  const row=await db.prepare(`${JOINED_MOTIONS} WHERE m.id=?`).bind(motionId).first(); if(!row) throw sponsorError('Motion not found',404);
  const commitment=await db.prepare('SELECT * FROM sponsorships WHERE motion_id=?').bind(motionId).first();
  const activities=(await db.prepare('SELECT a.*,u.name AS actor_name FROM sponsorship_activities a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.motion_id=? ORDER BY a.created_at DESC,a.id DESC').bind(motionId).all()).results;
  return {ok:true,item:await projectMotion(row),commitment,activities};
}
export async function addSponsorActivity(db,motionId,input,options) {
  validateInputObject(input);
  const c=await mutationContext(db,`activity:${motionId}`,input,options); if(c.replay)return c.replay;
  await getRow(db,'motions',motionId);
  const now=new Date().toISOString();
  const activity=activityStatement(db,motionId,c.actorUserId,trim(input.type||'note',50),required(input.description,'Activity description'),now);
  return commitMutation(db,c,[activity.statement,auditStatement(db,{actorUserId:c.actorUserId,operation:'activity.create',targetId:motionId,now})],{status:201,body:{ok:true,item:activity.item}},now);
}
