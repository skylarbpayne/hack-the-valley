import { getDb, requireAdmin } from '../../../_lib/event-platform.js';
import { mutateSponsor, listSponsorRecords, getSponsorMotion, listSponsorOwners, addSponsorActivity, sponsorError } from '../../../_lib/domain/sponsorships.js';
import { listReminderPreviews, captureReminderPreviews, listReminderDigests } from '../../../_lib/domain/sponsorship-reminders.js';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
async function handle(context) {
  try {
    const {request,env}=context;
    const access=await requireAdmin(request,env);
    if(access.bootstrap || !access.user?.id)throw sponsorError('A signed-in admin session is required',403);
    const db=getDb(env),url=new URL(request.url),method=request.method;
    const parts=url.pathname.replace(/^\/api\/admin\/sponsorships\/?/,'').split('/').filter(Boolean).map(decodeURIComponent);
    const [resource,rowId,action]=parts;
    if(parts.length>3)throw sponsorError('Not found',404);
    const preview=env.SPONSORSHIP_REMINDERS_MODE==='preview';
    const options={actorUserId:access.user.id,key:request.headers.get('Idempotency-Key')};
    if(method!=='GET') {
      const origin=request.headers.get('Origin');
      if(origin && origin!==url.origin)throw sponsorError('Cross-origin changes are not allowed',403);
      if(request.headers.get('Sec-Fetch-Site')==='cross-site')throw sponsorError('Cross-origin changes are not allowed',403);
    }
    if(!resource && method==='GET')return json({ok:true,user:{id:access.user.id,name:access.user.name,email:access.user.email},preview_mode:preview});
    if(resource==='owners' && !rowId && method==='GET') {const items=await listSponsorOwners(db);return json({ok:true,items,count:items.length});}
    if(resource==='events' && !rowId && method==='GET') {
      const items=(await db.prepare('SELECT id,title,event_slug,starts_at FROM event_instances ORDER BY starts_at DESC LIMIT 200').all()).results;return json({ok:true,items,count:items.length});
    }
    if(resource==='reminders') {
      if(!preview)throw sponsorError('Reminder previews are available only in preview mode',404);
      if(method==='GET' && !rowId){const items=await listReminderDigests(db);return json({ok:true,items,count:items.length});}
      if(rowId==='preview' && !action) {
        if(method==='GET'){const items=await listReminderPreviews(db,{origin:url.origin});return json({ok:true,items,count:items.length});}
        if(method==='POST')return json({ok:true,...await captureReminderPreviews(db,{origin:url.origin})});
      }
    }
    if(resource==='motions' && rowId && action==='logo') {
      const {getSponsorLogo,uploadSponsorLogo}=await import('../../../_lib/domain/sponsorship-logos.js');
      if(method==='GET')return await getSponsorLogo(db,env.SUBMISSIONS_MEDIA,rowId);
      if(method==='POST') {const result=await uploadSponsorLogo(db,env.SUBMISSIONS_MEDIA,rowId,request,options);return json(result.body,result.status);}
    }
    if(method==='GET') {
      if(['contacts','campaigns','motions'].includes(resource) && !rowId)return json(await listSponsorRecords(db,resource,Object.fromEntries(url.searchParams)));
      if(resource==='motions' && rowId) {
        const detail=await getSponsorMotion(db,rowId);
        if(!action)return json(detail);
        if(action==='commitment')return json({ok:true,item:detail.commitment});
        if(action==='activities')return json({ok:true,items:detail.activities,count:detail.activities.length});
      }
      if(['contacts','campaigns'].includes(resource) && rowId && !action) {
        const table=resource==='contacts'?'sponsor_contacts':'sponsorship_campaigns';
        const item=await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(rowId).first();
        if(!item)throw sponsorError('Record not found',404);return json({ok:true,item});
      }
    }
    if(['POST','PATCH'].includes(method)) {
      if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw sponsorError('Use application/json',415);
      const raw=await request.text();if(raw.length>50000)throw sponsorError('Request is too large',413);
      let input;try{input=JSON.parse(raw);}catch{throw sponsorError('Request body must be valid JSON');}
      let result;
      if(resource==='motions' && rowId && action==='activities' && method==='POST')result=await addSponsorActivity(db,rowId,input,options);
      else if(resource==='motions' && rowId && action==='commitment' && method==='PATCH')result=await mutateSponsor(db,'commitment',rowId,input,options);
      else if(['contacts','campaigns','motions'].includes(resource) && !action && ((method==='POST'&&!rowId)||(method==='PATCH'&&rowId)))result=await mutateSponsor(db,resource,rowId||null,input,options);
      if(result)return json(result.body,result.status);
    }
    throw sponsorError('Not found or unsupported operation',404);
  } catch(error) {
    if(!error.status)console.error('Sponsorship request failed',error);
    return json({ok:false,error:error.status?error.message:'Unable to complete the request. Please retry.'},error.status||500);
  }
}
export const onRequestGet=handle;
export const onRequestPost=handle;
export const onRequestPatch=handle;
