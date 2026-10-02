// Fictional, local-only fixtures. Stable IDs and INSERT OR IGNORE preserve edits.
import { deflateSync } from 'node:zlib';
export const DEMO_USERS = { danny: 'usr_sponsor_danny', alex: 'usr_sponsor_alex', member: 'usr_sponsor_member' };
export const DEMO_LOGO_KEY = 'sponsorships/sp_demo_07/demo-logo.png';
export function demoLogoPng() {
  const size = 128;
  const rows = Buffer.alloc((size * 3 + 1) * size);
  const letters = ['10111110101','10101010101','11101010101','10101010101','10101010010'];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = Math.floor((x - 20) / 8), gy = Math.floor((y - 44) / 8);
    const white = gx >= 0 && gx < 11 && gy >= 0 && gy < 5 && letters[gy][gx] === '1';
    const offset = y * (size * 3 + 1) + 1 + x * 3;
    rows.set(white ? [255,255,255] : [37,99,235], offset);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type),data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
    const header = Buffer.alloc(4), trailer = Buffer.alloc(4);
    header.writeUInt32BE(data.length); trailer.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([header,body,trailer]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size,0); header.writeUInt32BE(size,4); header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
export function userFixtureSql() {
  return `
    INSERT OR IGNORE INTO users (id,email,name,created_at,updated_at) VALUES
      ('${DEMO_USERS.danny}','danny@example.com','Danny Demo',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      ('${DEMO_USERS.alex}','alex@example.com','Alex Demo',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      ('${DEMO_USERS.member}','member@example.com','Member Demo',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT OR IGNORE INTO roles (id,user_id,role,scope_type,scope_id,created_at) VALUES
      ('role_sponsor_danny','${DEMO_USERS.danny}','super_admin','global','*',CURRENT_TIMESTAMP),
      ('role_sponsor_alex','${DEMO_USERS.alex}','admin','global','*',CURRENT_TIMESTAMP);
  `;
}

// The same historical prerequisites seeded by scripts/check-migrations.mjs.
// These must exist after 0013 and before 0014; they are local fixture data only.
export function compatibilityFixtureSql() {
  return `
    INSERT OR IGNORE INTO events (slug,title,status,created_at,updated_at)
    VALUES ('hack-the-valley-2026','Hack the Valley 2026','archived',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT OR IGNORE INTO projects (id,slug,title,created_at,updated_at) VALUES
      ('prj_decode_it','decode-it','Decode It',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      ('prj_valley_sat_prep','valley-sat-prep','Valley SAT Prep',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      ('prj_techpath_kern','techpath-kern','TechPath Kern',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      ('prj_continuum','continuum','Continuum',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
  `;
}

const sqlValue = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const insert = (table, row) => `INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(sqlValue).join(',')});`;

export function sponsorshipFixtureSql(now = new Date(), logoBytes = null) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric',month:'2-digit',day:'2-digit' }).format(now);
  const date = delta => new Date(Date.parse(`${today}T12:00:00Z`) + delta * 86400000).toISOString().slice(0,10);
  const timestamp = now.toISOString();
  const audit = { created_at: timestamp, updated_at: timestamp, created_by_user_id: DEMO_USERS.danny, updated_by_user_id: DEMO_USERS.danny };
  const statements = [userFixtureSql()];
  statements.push(insert('sponsorship_campaigns', { id:'scamp_demo_2027',name:'HTV 2027',year:2027,purpose:'Student innovation in the Central Valley',...audit }));
  statements.push(insert('sponsorship_campaigns', { id:'scamp_demo_2026',name:'HTV 2026',year:2026,purpose:'Previous annual campaign',archived_at:timestamp,...audit }));
  const examples = [
    ['Sunrise Circuit Labs','Jamie Chen','not_contacted','danny',null,'Find an introduction'],
    ['Valley Grove Coffee','Morgan Lee','contacted','danny',0,'Call about breakfast sponsorship'],
    ['Canyon Codeworks','Riley Patel','followup','danny',-3,'Send the updated sponsor packet'],
    ['Orchard Data Studio','Taylor Ruiz','interest','alex',4,'Share student project examples'],
    ['Mesa Robotics','Sam Nguyen','negotiating','alex',-2,'Confirm the proposed package'],
    ['Riverbend Print Co','Casey Garcia','lost','danny',-10,'Closed for this campaign'],
    ['Bluebird Networks','Jordan Kim','committed','danny',-1,'Confirm arrival of remaining check'],
    ['Golden Field Solar','Avery Singh','paid','alex',-6,'Cash received; thank-you sent'],
    ['Sequoia Snack Kitchen','Drew Rivera','committed','alex',-4,'Confirm delivery details'],
    ['Copper Creek Makers','Quinn Brooks','committed','danny',null,'Collect logo and workshop details'],
  ];
  examples.forEach(([business,person,status,owner,offset,nextAction], index) => {
    const suffix = String(index + 1).padStart(2,'0');
    const id = `sc_demo_${suffix}`, motionId = `sm_demo_${suffix}`;
    statements.push(insert('sponsor_contacts',{ id,business_name:business,contact_name:person,email:`sponsor${suffix}@example.com`,phone:`555-010${index}`,website:`https://sponsor${suffix}.example.com`,notes:'Fictional business for the local sponsorship prototype.',...audit }));
    statements.push(insert('sponsorship_motions',{ id:motionId,contact_id:id,campaign_id:'scamp_demo_2027',owner_user_id:DEMO_USERS[owner],status,notes:index===2?'Introduced HTV by email. Sponsor asked for the package.':'Sample outreach summary.',next_action:nextAction,follow_up_on:offset==null?null:date(offset),follow_up_completed_at:index===8?timestamp:null,...audit }));
    statements.push(insert('sponsorship_activities',{ id:`sact_demo_${suffix}`,motion_id:motionId,actor_user_id:DEMO_USERS[owner],type:'note',description:index===2?'Sent introduction email and discussed sponsorship options.':'Added to the local demo campaign.',created_at:timestamp }));
    if (['committed','paid'].includes(status)) {
      const base = { id:`sp_demo_${suffix}`,motion_id:motionId,contribution_type:index===8?'in_kind':index===9?'both':'cash',committed_cents:index===8?null:index===9?50000:100000,received_cents:index===7?100000:index===6?40000:0,in_kind_description:index===8?'Lunch for 60 student participants':index===9?'Workshop materials and mentor time':null,fulfilled_at:null,payment_method:index===6?'check':index===7?'bank_transfer':null,check_reference:index===6?'DEMO-1042':null,invoice_number:index===6?'DEMO-2027-007':index===7?'DEMO-2027-008':null,invoice_status:index===7?'paid':index===6?'issued':'not_issued',...audit };
      if (index===6) Object.assign(base,{logo_storage_key:DEMO_LOGO_KEY,logo_content_type:'image/png',logo_original_filename:'demo-logo.png',logo_bytes:logoBytes});
      statements.push(insert('sponsorships',base));
    }
  });
  statements.push(insert('sponsorship_motions',{ id:'sm_demo_previous',contact_id:'sc_demo_01',campaign_id:'scamp_demo_2026',owner_user_id:DEMO_USERS.alex,status:'paid',notes:'Previous-year sponsorship. Reused contact, separate outreach history.',follow_up_on:date(-60),...audit }));
  statements.push(insert('sponsorships',{ id:'sp_demo_previous',motion_id:'sm_demo_previous',committed_cents:75000,received_cents:75000,...audit }));
  return statements.join('\n');
}
