// Local-only browser fixture: real Admin HTML + Worker routes + SQLite.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import worker from '../../worker.js';
import { createSponsorshipDb, DEMO_USERS } from './sponsorship-db.mjs';
import { sponsorHash } from '../../functions/_lib/domain/sponsorships.js';

const { db, sqlite } = await createSponsorshipDb();
await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
  .bind('browser-owner', DEMO_USERS.danny, await sponsorHash('browser-owner'), '2026-01-01', '2099-01-01').run();
const env = { HTV_DB: db, HTV_SOCIAL_VAULT_KEY: Buffer.alloc(32, 7).toString('base64') };
const assets = new Map([
  ['/admin', ['../../public/admin.html', 'text/html; charset=utf-8']],
  ['/admin-message-draft.js', ['../../public/admin-message-draft.js', 'text/javascript']],
  ['/admin-blog-posts.js', ['../../public/admin-blog-posts.js', 'text/javascript']]
]);
createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://127.0.0.1:8799').pathname;
    if (assets.has(path)) {
      const [file, type] = assets.get(path);
      res.writeHead(200, { 'Content-Type': type, ...(path === '/admin' ? { 'Set-Cookie': 'htv_session=browser-owner; Path=/; SameSite=Lax' } : {}) });
      res.end(readFileSync(new URL(file, import.meta.url)));
      return;
    }
    if (!path.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://127.0.0.1:8799${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { console.error(error); res.writeHead(500); res.end('Fixture error'); }
}).listen(8799, '127.0.0.1', () => console.log('HTV local browser fixture ready http://127.0.0.1:8799/admin#access'));
process.on('SIGTERM', () => sqlite.close());
