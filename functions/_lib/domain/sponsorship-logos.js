import { sponsorError, sponsorHash, mutationContext, commitMutation } from './sponsorships.js';
const MAX_BYTES=5*1024*1024;
async function readImage(request) {
  const type=(request.headers.get('Content-Type')||'').split(';')[0].toLowerCase();
  if(!['image/png','image/jpeg','image/webp'].includes(type))throw sponsorError('Use a PNG, JPEG, or WebP logo');
  if(Number(request.headers.get('Content-Length'))>MAX_BYTES)throw sponsorError('Logo exceeds 5 MB',413);
  const reader=request.body?.getReader();if(!reader)throw sponsorError('Image data is required');
  const chunks=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_BYTES){await reader.cancel();throw sponsorError('Logo exceeds 5 MB',413);}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const text=(start,end)=>String.fromCharCode(...bytes.slice(start,end));
  const png=length>=24 && [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v) && text(12,16)==='IHDR';
  const jpeg=length>=4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  const webp=length>=16 && text(0,4)==='RIFF' && text(8,12)==='WEBP';
  if(!({'image/png':png,'image/jpeg':jpeg,'image/webp':webp}[type]))throw sponsorError('Image signature does not match its file type');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  return {bytes,type,digest};
}
async function commitment(db,motionId){
  const row=await db.prepare('SELECT * FROM sponsorships WHERE motion_id=?').bind(motionId).first();
  if(!row)throw sponsorError('Mark this motion Committed before uploading a logo',404);return row;
}
export async function getSponsorLogo(db,bucket,motionId){
  if(!bucket)throw sponsorError('Logo storage is not configured',503);
  const row=await commitment(db,motionId);
  const object=row.logo_storage_key?await bucket.get(row.logo_storage_key):null;
  if(!object)throw sponsorError('No logo uploaded',404);
  return new Response(object.body,{headers:{'Content-Type':row.logo_content_type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});
}
export async function uploadSponsorLogo(db,bucket,motionId,request,options){
  if(!bucket)throw sponsorError('Logo storage is not configured',503);
  const {bytes,type,digest}=await readImage(request);
  const revision=Number(request.headers.get('X-Revision'));
  const filename=(request.headers.get('X-Filename')||'sponsor-logo').replace(/[\r\n/\\]/g,'').slice(0,250);
  const c=await mutationContext(db,`logo:${motionId}`,{revision,type,filename,digest},options);if(c.replay)return c.replay;
  const row=await commitment(db,motionId);
  if(!Number.isInteger(revision) || row.revision!==revision){
    const retry=await mutationContext(db,`logo:${motionId}`,{revision,type,filename,digest},options);
    if(retry.replay)return retry.replay;
    throw sponsorError('Record changed. Refresh before uploading the logo.',409);
  }
  const operationDigest=await sponsorHash(`${c.actorUserId}:${c.operation}:${c.key}:${digest}`);
  const storageKey=`sponsorships/${row.id}/${operationDigest}`;
  const now=new Date().toISOString(),guardId=crypto.randomUUID();
  const item={...row,logo_storage_key:storageKey,logo_content_type:type,logo_original_filename:filename,logo_bytes:bytes.length,revision:revision+1,updated_at:now,updated_by_user_id:c.actorUserId};
  // R2 and D1 cannot commit atomically. On metadata failure retain the object:
  // another same-key request may still be about to commit this exact key.
  // A retry reuses it; unreferenced failures remain until deferred cleanup or
  // local reset, rather than risking a successful reference to a deleted logo.
  await bucket.put(storageKey,bytes,{httpMetadata:{contentType:type}});
  const statements=[
      db.prepare('INSERT INTO sponsorship_write_guards(id,valid) VALUES (?,(SELECT COUNT(*) FROM sponsorships WHERE id=? AND revision=?))').bind(guardId,row.id,revision),
      db.prepare('UPDATE sponsorships SET logo_storage_key=?,logo_content_type=?,logo_original_filename=?,logo_bytes=?,revision=revision+1,updated_at=?,updated_by_user_id=? WHERE id=? AND revision=?').bind(storageKey,type,filename,bytes.length,now,c.actorUserId,row.id,revision),
      db.prepare('DELETE FROM sponsorship_write_guards WHERE id=?').bind(guardId),
      db.prepare('INSERT INTO audit_events(id,action,actor_user_id,target_type,target_id,scope_type,scope_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'sponsorship.logo.upload',c.actorUserId,'sponsorship',row.id,'sponsorship',row.id,'{}',now)
  ];
  const result=await commitMutation(db,c,statements,{status:200,body:{ok:true,item}},now);
  if(row.logo_storage_key && row.logo_storage_key!==storageKey)await bucket.delete(row.logo_storage_key).catch(()=>{});
  return result;
}
