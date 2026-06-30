import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  absolutizeUrls,
  buildBroadcastEmailHtml,
} from '../functions/_shared/blog-broadcast.js';
import { BlogPost } from '../functions/_lib/domain/blog-post.js';
import {
  broadcastIdempotencyKey,
  createBroadcast,
  fetchBroadcastStatus,
  mapResendBroadcastStatus,
  normalizeScheduledAt,
  reconcileBroadcastSends,
  resolveAudienceId,
  resolveBroadcastConfig,
  scheduleBroadcast,
  sendBroadcast,
} from '../functions/_lib/domain/blog-broadcast.js';
import { onRequestPost, onRequestGet, onRequest } from '../functions/api/blog/broadcast.js';

// A valid, comfortably-future schedule for handler tests (well past the buffer).
function futureIso(msAhead = 60 * 60 * 1000) {
  return new Date(Date.now() + msAhead).toISOString();
}

// --- helpers ---------------------------------------------------------------

function mockFetch(responses, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() || { status: 200, body: {} };
    return new Response(JSON.stringify(next.body || {}), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function mockAssets(files) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const body = files[url.pathname];
      if (body === undefined) return new Response('not found', { status: 404 });
      const isJson = url.pathname.endsWith('.json');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': isJson ? 'application/json' : 'text/html; charset=utf-8' },
      });
    },
  };
}

// Mirrors the role-aware mock DB used in event-platform.test.mjs, extended with
// an in-memory blog_broadcast_sends table so the idempotency guard is exercised.
// Pass a shared `store` Map across calls to simulate persistence between retries.
function adminDb({ role = 'admin', store = new Map() } = {}) {
  return {
    store,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM user_sessions/.test(sql)) {
            return { id: 'usr_admin', email: 'admin@example.com', name: 'Admin', session_id: 'ses', session_expires_at: '2099-01-01T00:00:00.000Z' };
          }
          if (/FROM roles/.test(sql)) {
            return role && this.args.includes(role) ? { role, scope_type: 'global', scope_id: '*', created_at: '2026-01-01T00:00:00.000Z' } : null;
          }
          if (/FROM blog_broadcast_sends/.test(sql)) {
            return store.get(this.args[0]) || null;
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async run() {
          if (/INSERT INTO blog_broadcast_sends/.test(sql)) {
            const [key, slug, scheduled_at, status, created_at, updated_at] = this.args;
            if (store.has(key)) {
              throw new Error('UNIQUE constraint failed: blog_broadcast_sends.idempotency_key');
            }
            store.set(key, { idempotency_key: key, slug, scheduled_at, status, broadcast_id: null, created_at, updated_at });
            return { success: true };
          }
          if (/UPDATE blog_broadcast_sends/.test(sql)) {
            const key = this.args[this.args.length - 1];
            const row = store.get(key);
            if (row) {
              const statusMatch = sql.match(/status = '(\w+)'/);
              if (statusMatch) {
                row.broadcast_id = this.args[0];
                row.status = statusMatch[1];
                if (row.status === 'send_failed') row.error = this.args[1];
              }
            }
            return { success: true };
          }
          if (/DELETE FROM blog_broadcast_sends/.test(sql)) {
            store.delete(this.args[0]);
            return { success: true };
          }
          throw new Error(`Unexpected run() query: ${sql}`);
        },
        async all() {
          if (/FROM blog_broadcast_sends/.test(sql)) {
            return { results: [...store.values()] };
          }
          return { results: [] };
        },
      };
    },
  };
}

const POST_HTML = [
  '<html><head><title>Test Post</title></head><body>',
  '<!-- POST:START -->',
  '<div class="post-body"><p>Hello world.</p><img src="/images/blog/x.png" alt="x"></div>',
  '<!-- POST:END -->',
  '<aside>CTA chrome we do not want in the email body</aside>',
  '</body></html>',
].join('\n');

const MANIFEST = JSON.stringify({ posts: [{ slug: 'test-post', title: 'Test Post', excerpt: 'hi' }] });

function broadcastRequest(body, { cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request('https://hackthevalley.org/api/blog/broadcast', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function assets() {
  return mockAssets({ '/blog/posts.json': MANIFEST, '/blog/test-post': POST_HTML });
}

// --- pure helpers ----------------------------------------------------------

test('BlogPost.body returns the content between the markers (mechanism stays hidden)', () => {
  const content = new BlogPost({ slug: 'test-post', rawHtml: POST_HTML }).body();
  assert.match(content, /Hello world/);
  assert.doesNotMatch(content, /CTA chrome/);
  assert.doesNotMatch(content, /<title>/);
});

test('BlogPost.body throws 422 when the post has no body markers', () => {
  assert.throws(() => new BlogPost({ slug: 'x', rawHtml: '<p>no markers</p>' }).body(), (err) => err.status === 422);
});

test('absolutizeUrls rewrites root-relative URLs and leaves absolute ones', () => {
  const out = absolutizeUrls('<img src="/images/x.png"><a href="https://x.com">e</a><img src="//cdn/y">', 'https://hackthevalley.org');
  assert.match(out, /src="https:\/\/hackthevalley\.org\/images\/x\.png"/);
  assert.match(out, /href="https:\/\/x\.com"/);
  assert.match(out, /src="\/\/cdn\/y"/);
});

test('buildBroadcastEmailHtml includes title, upcoming-events CTA, submission CTA, and unsubscribe token', () => {
  const html = buildBroadcastEmailHtml({
    title: 'My Post',
    contentHtml: '<p>body</p>',
    postUrl: 'https://hackthevalley.org/blog/my-post',
    eventsUrl: 'https://hackthevalley.org/events',
  });
  assert.match(html, /My Post/);
  assert.match(html, /<p>body<\/p>/);
  assert.match(html, /See upcoming events/);
  assert.match(html, /href="https:\/\/hackthevalley\.org\/events"/);
  assert.match(html, /Want to highlight something on the Hack the Valley blog\? Reply to this email/);
  assert.match(html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
});

test('buildBroadcastEmailHtml constrains image width inline so screenshots do not overflow', () => {
  const html = buildBroadcastEmailHtml({
    title: 'P',
    contentHtml: '<figure><img src="https://h.org/images/big.png" alt="x"><figcaption>cap</figcaption></figure>',
  });
  // the <img> must get an inline max-width (email clients ignore <style>)
  assert.match(html, /<img style="[^"]*max-width:100%[^"]*"\s+src="https:\/\/h\.org\/images\/big\.png"/);
  assert.match(html, /<figcaption style="[^"]*text-align:center/);
});

test('resolveBroadcastConfig requires an API key and sender', () => {
  assert.throws(() => resolveBroadcastConfig({}), (err) => {
    return err.status === 503 && /RESEND_API_KEY/.test(err.message) && /RESEND_BROADCAST_FROM/.test(err.message);
  });
  const config = resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>' });
  assert.equal(config.from, 'HTV <a@b.co>');
  assert.equal(config.replyTo, 'contact@hackthevalley.org');
  const custom = resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>', RESEND_BROADCAST_REPLY_TO: 'blog@hackthevalley.org' });
  assert.equal(custom.replyTo, 'blog@hackthevalley.org');
});

test('resolveAudienceId prefers explicit id, auto-discovers one audience, and skips empty whole-list placeholders', async () => {
  assert.equal(await resolveAudienceId({ env: { RESEND_AUDIENCE_ID: 'aud_x' } }), 'aud_x');
  const oneAudience = mockFetch([{ status: 200, body: { data: [{ id: 'aud_solo', name: 'HTV list' }] } }]);
  assert.equal(await resolveAudienceId({ env: { RESEND_API_KEY: 'k' }, fetcher: oneAudience }), 'aud_solo');
  const emptyGeneral = mockFetch([
    { status: 200, body: { data: [{ id: 'aud_event', name: 'Hack the Valley 2026' }, { id: 'aud_general', name: 'General' }] } },
    { status: 200, body: { data: [{ id: 'contact_1' }] } },
    { status: 200, body: { data: [] } },
  ]);
  assert.equal(await resolveAudienceId({ env: { RESEND_API_KEY: 'k' }, fetcher: emptyGeneral }), 'aud_event');
  const populatedGeneral = mockFetch([
    { status: 200, body: { data: [{ id: 'aud_event', name: 'Hack the Valley 2026' }, { id: 'aud_general', name: 'General' }] } },
    { status: 200, body: { data: [] } },
    { status: 200, body: { data: [{ id: 'contact_1' }] } },
  ]);
  assert.equal(await resolveAudienceId({ env: { RESEND_API_KEY: 'k' }, fetcher: populatedGeneral }), 'aud_general');
});

test('resolveAudienceId refuses to guess when multiple populated audiences have no whole-list audience', async () => {
  const many = mockFetch([
    { status: 200, body: { data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } },
    { status: 200, body: { data: [{ id: 'contact_a' }] } },
    { status: 200, body: { data: [{ id: 'contact_b' }] } },
  ]);
  await assert.rejects(resolveAudienceId({ env: { RESEND_API_KEY: 'k' }, fetcher: many }), (err) => err.status === 409);
});

test('resolveAudienceId errors when there are no audiences', async () => {
  const none = mockFetch([{ status: 200, body: { data: [] } }]);
  await assert.rejects(resolveAudienceId({ env: { RESEND_API_KEY: 'k' }, fetcher: none }), (err) => err.status === 503);
});

test('createBroadcast posts the audience/from and returns the id', async () => {
  const calls = [];
  const fetcher = mockFetch([{ status: 200, body: { id: 'bc_123' } }], calls);
  const id = await createBroadcast({
    env: { RESEND_API_KEY: 'k' }, fetcher,
    audienceId: 'aud_1', from: 'HTV <a@b.co>', replyTo: 'contact@hackthevalley.org', subject: 'Hi', name: 'Blog: x', html: '<p>e</p>',
  });
  assert.equal(id, 'bc_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/broadcasts');
  const createBody = JSON.parse(calls[0].init.body);
  assert.equal(createBody.audience_id, 'aud_1');
  assert.equal(createBody.from, 'HTV <a@b.co>');
  assert.deepEqual(createBody.reply_to, ['contact@hackthevalley.org']);
});

test('createBroadcast throws 502 if create fails', async () => {
  const fetcher = mockFetch([{ status: 400, body: { message: 'bad' } }]);
  await assert.rejects(
    createBroadcast({ env: { RESEND_API_KEY: 'k' }, fetcher, audienceId: 'a', from: 'f', subject: 's', html: 'h' }),
    (err) => err.status === 502,
  );
});

test('sendBroadcast posts scheduled_at to the broadcast send endpoint', async () => {
  const calls = [];
  const fetcher = mockFetch([{ status: 200, body: {} }], calls);
  const result = await sendBroadcast({ env: { RESEND_API_KEY: 'k' }, fetcher, broadcastId: 'bc_123', scheduledAt: '2026-07-01T00:00:00.000Z' });
  assert.equal(result.scheduled, true);
  assert.equal(calls[0].url, 'https://api.resend.com/broadcasts/bc_123/send');
  assert.equal(JSON.parse(calls[0].init.body).scheduled_at, '2026-07-01T00:00:00.000Z');
});

test('sendBroadcast throws 502 if the send fails', async () => {
  const fetcher = mockFetch([{ status: 500, body: { message: 'boom' } }]);
  await assert.rejects(
    sendBroadcast({ env: { RESEND_API_KEY: 'k' }, fetcher, broadcastId: 'bc_1', scheduledAt: '2026-07-01T00:00:00.000Z' }),
    (err) => err.status === 502,
  );
});

// --- route handler ---------------------------------------------------------

test('handler rejects non-admins with 401', async () => {
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post' }),
    env: { HTV_DB: {}, ASSETS: assets() },
  });
  assert.equal(response.status, 401);
});

test('handler dry run returns rendered email without calling Resend', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: assets() },
    fetch: mockFetch([], calls),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dryRun, true);
  assert.equal(body.subject, 'Test Post');
  assert.match(body.html, /Hello world/);
  assert.match(body.html, /See upcoming events/);
  assert.match(body.html, /Want to highlight something on the Hack the Valley blog\? Reply to this email/);
  // image rewritten to absolute for email clients
  assert.match(body.html, /src="https:\/\/hackthevalley\.org\/images\/blog\/x\.png"/);
  assert.equal(calls.length, 0, 'dry run must not hit Resend');
});

test('handler schedules a broadcast for an admin', async () => {
  const calls = [];
  const scheduledAt = futureIso();
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', subject: 'Custom subject', scheduledAt }, { cookie: 'htv_session=tok' }),
    env: {
      HTV_DB: adminDb(), ASSETS: assets(),
      RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1', RESEND_BROADCAST_FROM: 'HTV <a@b.co>',
    },
    fetch: mockFetch([{ status: 200, body: { id: 'bc_9' } }, { status: 200, body: { id: 'bc_9' } }], calls),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.broadcastId, 'bc_9');
  assert.equal(body.subject, 'Custom subject');
  assert.equal(body.scheduledAt, scheduledAt);
  // accepted by Resend != delivered: the row is 'scheduled', reconciled later
  assert.equal(body.status, 'scheduled');
  assert.equal(calls.length, 2);
  const createBody = JSON.parse(calls[0].init.body);
  assert.match(createBody.html, /See upcoming events/);
  assert.match(createBody.html, /Want to highlight something on the Hack the Valley blog\? Reply to this email/);
  assert.deepEqual(createBody.reply_to, ['contact@hackthevalley.org']);
  // the schedule is forwarded to Resend's send call
  assert.equal(JSON.parse(calls[1].init.body).scheduled_at, scheduledAt);
});

test('handler auto-discovers the only populated audience when General exists but is empty', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt: futureIso() }, { cookie: 'htv_session=tok' }),
    env: {
      HTV_DB: adminDb(), ASSETS: assets(),
      RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>', // no RESEND_AUDIENCE_ID
    },
    fetch: mockFetch([
      { status: 200, body: { data: [{ id: 'aud_event', name: 'Hack the Valley 2026' }, { id: 'aud_general', name: 'General' }] } }, // GET /audiences
      { status: 200, body: { data: [{ id: 'contact_1' }] } }, // GET /audiences/aud_event/contacts
      { status: 200, body: { data: [] } }, // GET /audiences/aud_general/contacts
      { status: 200, body: { id: 'bc_1' } }, // POST /broadcasts
      { status: 200, body: { id: 'bc_1' } }, // POST /broadcasts/:id/send
    ], calls),
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'https://api.resend.com/audiences');
  assert.equal(calls[1].url, 'https://api.resend.com/audiences/aud_event/contacts');
  assert.equal(calls[2].url, 'https://api.resend.com/audiences/aud_general/contacts');
  const createBody = JSON.parse(calls[3].init.body);
  assert.equal(createBody.audience_id, 'aud_event');
});

test('handler returns 404 for an unknown slug', async () => {
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'nope' }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: assets() },
    fetch: mockFetch([]),
  });
  assert.equal(response.status, 404);
});

test('handler returns 503 when Resend is not configured', async () => {
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt: futureIso() }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: assets() },
    fetch: mockFetch([]),
  });
  assert.equal(response.status, 503);
});

// --- schedule validation ---------------------------------------------------

test('normalizeScheduledAt requires a value', () => {
  assert.throws(() => normalizeScheduledAt(''), (err) => err.status === 422);
  assert.throws(() => normalizeScheduledAt(null), (err) => err.status === 422);
  assert.throws(() => normalizeScheduledAt(undefined), (err) => err.status === 422);
});

test('normalizeScheduledAt rejects an invalid date', () => {
  assert.throws(() => normalizeScheduledAt('not-a-date'), (err) => err.status === 422 && /valid/.test(err.message));
});

test('normalizeScheduledAt rejects a past or too-soon time', () => {
  const now = Date.parse('2026-06-22T12:00:00.000Z');
  // in the past
  assert.throws(() => normalizeScheduledAt('2026-06-22T11:00:00.000Z', { now }), (err) => err.status === 422);
  // within the 10-minute buffer
  assert.throws(() => normalizeScheduledAt('2026-06-22T12:05:00.000Z', { now }), (err) => err.status === 422);
});

test('normalizeScheduledAt accepts a sufficiently future time and returns ISO', () => {
  const now = Date.parse('2026-06-22T12:00:00.000Z');
  const out = normalizeScheduledAt('2026-06-22T13:00:00.000Z', { now });
  assert.equal(out, '2026-06-22T13:00:00.000Z');
});

test('handler sends immediately when no scheduled time is provided', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post' }, { cookie: 'htv_session=tok' }),
    env: {
      HTV_DB: adminDb(), ASSETS: assets(),
      RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1', RESEND_BROADCAST_FROM: 'HTV <a@b.co>',
    },
    fetch: mockFetch([{ status: 200, body: { id: 'bc_now' } }, { status: 200, body: { id: 'bc_now' } }], calls),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.broadcastId, 'bc_now');
  assert.equal(body.scheduled, false);
  assert.equal(body.status, 'sending');
  assert.deepEqual(JSON.parse(calls[1].init.body), {});
});

test('handler rejects a past scheduled time before touching Resend (422)', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt: '2020-01-01T00:00:00.000Z' }, { cookie: 'htv_session=tok' }),
    env: {
      HTV_DB: adminDb(), ASSETS: assets(),
      RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1', RESEND_BROADCAST_FROM: 'HTV <a@b.co>',
    },
    fetch: mockFetch([], calls),
  });
  assert.equal(response.status, 422);
  assert.equal(calls.length, 0, 'must not call Resend for an invalid schedule');
});

// --- idempotency -----------------------------------------------------------

test('broadcastIdempotencyKey is stable for the same slug + time', () => {
  const a = broadcastIdempotencyKey('post', '2026-06-22T13:00:00.000Z');
  const b = broadcastIdempotencyKey('post', '2026-06-22T13:00:00.000Z');
  const c = broadcastIdempotencyKey('post', '2026-06-22T14:00:00.000Z');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// Routes Resend calls by URL so create can succeed while send fails/throws.
function broadcastFetcher({ createId = 'bc_x', onSend } = {}, calls = []) {
  return async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/broadcasts')) {
      return new Response(JSON.stringify({ id: createId }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/send')) return onSend();
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const SCHEDULED_ENV = { RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1', RESEND_BROADCAST_FROM: 'HTV <a@b.co>' };

test('scheduleBroadcast persists broadcast_id before send, so a thrown send is recoverable (no duplicate on retry)', async () => {
  const store = new Map();
  const db = adminDb({ store });
  const scheduledAt = futureIso();
  const calls = [];
  const fetcher = broadcastFetcher({ createId: 'bc_x', onSend: () => { throw new Error('network drop after create'); } }, calls);

  await assert.rejects(
    scheduleBroadcast(db, { slug: 'test-post', scheduledAt, subject: 's', name: 'Blog: x', html: '<p>e</p>', env: SCHEDULED_ENV, fetcher }),
    (err) => err.broadcastId === 'bc_x',
  );
  const row = [...store.values()][0];
  assert.equal(row.status, 'send_failed', 'row kept, not deleted');
  assert.equal(row.broadcast_id, 'bc_x', 'broadcast_id persisted before the send threw');
  const creates = calls.filter((u) => u.endsWith('/broadcasts')).length;
  assert.equal(creates, 1);

  // Retry the same slug + time: must collide on the idempotency key and NOT
  // create a second broadcast.
  await assert.rejects(
    scheduleBroadcast(db, { slug: 'test-post', scheduledAt, subject: 's', name: 'Blog: x', html: '<p>e</p>', env: SCHEDULED_ENV, fetcher }),
    (err) => err.status === 409 && err.broadcastId === 'bc_x',
  );
  assert.equal(calls.filter((u) => u.endsWith('/broadcasts')).length, 1, 'retry must not create a duplicate broadcast');
});

test('scheduleBroadcast records send_failed with the broadcastId when the send returns non-2xx', async () => {
  const store = new Map();
  const db = adminDb({ store });
  const fetcher = broadcastFetcher({
    createId: 'bc_p',
    onSend: () => new Response(JSON.stringify({ message: 'nope' }), { status: 500, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    scheduleBroadcast(db, { slug: 'p', scheduledAt: futureIso(), subject: 's', name: 'n', html: 'h', env: SCHEDULED_ENV, fetcher }),
    (err) => err.status === 502 && err.broadcastId === 'bc_p',
  );
  const row = [...store.values()][0];
  assert.equal(row.status, 'send_failed');
  assert.equal(row.broadcast_id, 'bc_p');
});

test('scheduleBroadcast releases the reservation when create fails (clean retry)', async () => {
  const store = new Map();
  const db = adminDb({ store });
  const fetcher = async (url) => {
    if (String(url).endsWith('/broadcasts')) {
      return new Response(JSON.stringify({ message: 'down' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(
    scheduleBroadcast(db, { slug: 'p', scheduledAt: futureIso(), subject: 's', name: 'n', html: 'h', env: SCHEDULED_ENV, fetcher }),
    (err) => err.status === 502,
  );
  assert.equal(store.size, 0, 'create failure must leave no reservation behind');
});

test('handler refuses a duplicate blast for the same post + time (409)', async () => {
  const env = {
    HTV_DB: adminDb(), ASSETS: assets(),
    RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1', RESEND_BROADCAST_FROM: 'HTV <a@b.co>',
  };
  const scheduledAt = futureIso();
  const first = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt }, { cookie: 'htv_session=tok' }),
    env,
    fetch: mockFetch([{ status: 200, body: { id: 'bc_1' } }, { status: 200, body: { id: 'bc_1' } }]),
  });
  assert.equal(first.status, 200);

  const second = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt }, { cookie: 'htv_session=tok' }),
    env, // same in-memory store -> idempotency key collides
    fetch: mockFetch([{ status: 200, body: { id: 'bc_2' } }, { status: 200, body: { id: 'bc_2' } }]),
  });
  assert.equal(second.status, 409);
});

test('handler allows a clean retry after a create failure (reservation released)', async () => {
  const env = {
    HTV_DB: adminDb(), ASSETS: assets(),
    RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1', RESEND_BROADCAST_FROM: 'HTV <a@b.co>',
  };
  const scheduledAt = futureIso();
  const failed = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt }, { cookie: 'htv_session=tok' }),
    env,
    fetch: mockFetch([{ status: 500, body: { message: 'create down' } }]), // create fails -> nothing at Resend
  });
  assert.equal(failed.status, 502);

  const retry = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt }, { cookie: 'htv_session=tok' }),
    env, // reservation should have been released
    fetch: mockFetch([{ status: 200, body: { id: 'bc_ok' } }, { status: 200, body: { id: 'bc_ok' } }]),
  });
  assert.equal(retry.status, 200);
});

test('handler does not orphan a pending row when audience resolution fails', async () => {
  const store = new Map();
  const db = adminDb({ store });
  const scheduledAt = futureIso();

  // No RESEND_AUDIENCE_ID configured, and Resend reports several audiences ->
  // resolveAudienceId throws 409 before anything is reserved.
  const ambiguous = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: db, ASSETS: assets(), RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>' },
    fetch: mockFetch([
      { status: 200, body: { data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } },
      { status: 200, body: { data: [{ id: 'contact_a' }] } },
      { status: 200, body: { data: [{ id: 'contact_b' }] } },
    ]),
  });
  assert.equal(ambiguous.status, 409);
  assert.equal(store.size, 0, 'a failed audience lookup must not leave a pending row behind');

  // Once the audience is disambiguated, the same slug + time can still be sent
  // (no forever-pending row blocks it on the idempotency key).
  const retry = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: db, ASSETS: assets(), RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1', RESEND_BROADCAST_FROM: 'HTV <a@b.co>' },
    fetch: mockFetch([{ status: 200, body: { id: 'bc_ok' } }, { status: 200, body: { id: 'bc_ok' } }]),
  });
  assert.equal(retry.status, 200);
});

// --- reconciliation (cron) -------------------------------------------------

// In-memory DB for the reconcile cron: serves the non-terminal SELECT and
// applies status / last_reconciled_at UPDATEs by row id.
function reconcileDb(seedRows) {
  const byId = new Map(seedRows.map((row) => [row.id, { ...row }]));
  return {
    rows: byId,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async all() {
          if (/SELECT[\s\S]*FROM blog_broadcast_sends/.test(sql)) {
            const results = [...byId.values()]
              .filter((r) => ['scheduled', 'sending', 'send_failed'].includes(r.status) && r.broadcast_id)
              .map((r) => ({ id: r.id, broadcast_id: r.broadcast_id, status: r.status }));
            return { results };
          }
          return { results: [] };
        },
        async run() {
          if (/UPDATE blog_broadcast_sends/.test(sql)) {
            const id = this.args[this.args.length - 1];
            const row = byId.get(id);
            if (row) {
              if (/SET status = \?/.test(sql)) {
                row.status = this.args[0];
                row.last_reconciled_at = this.args[1];
              } else {
                row.last_reconciled_at = this.args[0];
              }
            }
          }
          return { success: true };
        },
      };
    },
  };
}

test('mapResendBroadcastStatus maps Resend states to our state machine', () => {
  assert.equal(mapResendBroadcastStatus('sent'), 'sent');
  assert.equal(mapResendBroadcastStatus('queued'), 'sending');
  assert.equal(mapResendBroadcastStatus('scheduled'), 'scheduled');
  assert.equal(mapResendBroadcastStatus('draft'), 'canceled');
  assert.equal(mapResendBroadcastStatus('SENT'), 'sent'); // case-insensitive
  assert.equal(mapResendBroadcastStatus('something-new'), null); // unknown -> leave alone
  assert.equal(mapResendBroadcastStatus(undefined), null);
});

test('fetchBroadcastStatus returns status, handles 404, throws on transient error', async () => {
  const ok = mockFetch([{ status: 200, body: { id: 'bc_1', status: 'queued' } }]);
  assert.deepEqual(await fetchBroadcastStatus({ env: { RESEND_API_KEY: 'k' }, fetcher: ok, broadcastId: 'bc_1' }), { found: true, status: 'queued' });

  const gone = mockFetch([{ status: 404, body: {} }]);
  assert.deepEqual(await fetchBroadcastStatus({ env: { RESEND_API_KEY: 'k' }, fetcher: gone, broadcastId: 'bc_x' }), { found: false, status: null });

  const down = mockFetch([{ status: 500, body: {} }]);
  await assert.rejects(fetchBroadcastStatus({ env: { RESEND_API_KEY: 'k' }, fetcher: down, broadcastId: 'bc_1' }), (err) => err.status === 502);
});

test('reconcileBroadcastSends advances scheduled->sending and sending->sent', async () => {
  const db = reconcileDb([
    { id: 1, broadcast_id: 'bc_a', status: 'scheduled' },
    { id: 2, broadcast_id: 'bc_b', status: 'sending' },
  ]);
  const fetcher = mockFetch([
    { status: 200, body: { status: 'queued' } }, // bc_a -> sending
    { status: 200, body: { status: 'sent' } }, // bc_b -> sent
  ]);
  const summary = await reconcileBroadcastSends(db, {env: { RESEND_API_KEY: 'k' }, fetcher });
  assert.deepEqual(summary, { checked: 2, updated: 2, errors: 0 });
  assert.equal(db.rows.get(1).status, 'sending');
  assert.equal(db.rows.get(2).status, 'sent');
  assert.ok(db.rows.get(2).last_reconciled_at, 'records when it last checked');
});

test('reconcileBroadcastSends marks canceled on a draft revert or a 404', async () => {
  const db = reconcileDb([
    { id: 1, broadcast_id: 'bc_a', status: 'scheduled' },
    { id: 2, broadcast_id: 'bc_b', status: 'scheduled' },
  ]);
  const fetcher = mockFetch([
    { status: 200, body: { status: 'draft' } }, // schedule canceled -> canceled
    { status: 404, body: {} }, // broadcast deleted -> canceled
  ]);
  const summary = await reconcileBroadcastSends(db, {env: { RESEND_API_KEY: 'k' }, fetcher });
  assert.equal(summary.updated, 2);
  assert.equal(db.rows.get(1).status, 'canceled');
  assert.equal(db.rows.get(2).status, 'canceled');
});

test('reconcileBroadcastSends leaves a row untouched on a transient error', async () => {
  const db = reconcileDb([{ id: 1, broadcast_id: 'bc_a', status: 'sending' }]);
  const fetcher = mockFetch([{ status: 500, body: {} }]);
  const summary = await reconcileBroadcastSends(db, {env: { RESEND_API_KEY: 'k' }, fetcher });
  assert.deepEqual(summary, { checked: 1, updated: 0, errors: 1 });
  assert.equal(db.rows.get(1).status, 'sending', 'transient failure must not change the status');
});

test('reconcileBroadcastSends self-heals a send_failed row when Resend shows it actually sent', async () => {
  const db = reconcileDb([{ id: 1, broadcast_id: 'bc_a', status: 'send_failed' }]);
  const fetcher = mockFetch([{ status: 200, body: { status: 'sent' } }]);
  const summary = await reconcileBroadcastSends(db, { env: { RESEND_API_KEY: 'k' }, fetcher });
  assert.equal(summary.updated, 1);
  assert.equal(db.rows.get(1).status, 'sent', 'a lost send response is recovered, preventing a manual duplicate');
});

test('reconcileBroadcastSends leaves a send_failed row as send_failed when Resend still shows an unsent draft', async () => {
  const db = reconcileDb([{ id: 1, broadcast_id: 'bc_a', status: 'send_failed' }]);
  const fetcher = mockFetch([{ status: 200, body: { status: 'draft' } }]);
  const summary = await reconcileBroadcastSends(db, { env: { RESEND_API_KEY: 'k' }, fetcher });
  assert.equal(summary.updated, 0);
  assert.equal(db.rows.get(1).status, 'send_failed', 'genuinely-unsent draft is not silently canceled');
});

test('reconcileBroadcastSends only touches non-terminal rows and no-ops without an API key', async () => {
  const db = reconcileDb([
    { id: 1, broadcast_id: 'bc_a', status: 'sent' }, // terminal -> skipped
    { id: 2, broadcast_id: 'bc_b', status: 'pending' }, // no broadcast yet -> skipped
    { id: 3, broadcast_id: 'bc_c', status: 'scheduled' },
  ]);
  const calls = [];
  const fetcher = mockFetch([{ status: 200, body: { status: 'sent' } }], calls);
  const summary = await reconcileBroadcastSends(db, {env: { RESEND_API_KEY: 'k' }, fetcher });
  assert.equal(summary.checked, 1, 'only the scheduled row is polled');
  assert.equal(calls.length, 1);

  const noKey = await reconcileBroadcastSends(db, {env: {}, fetcher: mockFetch([], calls) });
  assert.equal(noKey.skipped, 'no-api-key');
  assert.equal(calls.length, 1, 'no Resend calls without an API key');
});

// --- manifest integrity ----------------------------------------------------

test('handler returns 422 (not 404) when posts.json is malformed', async () => {
  const badAssets = mockAssets({ '/blog/posts.json': '{ this is not json', '/blog/test-post': POST_HTML });
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt: futureIso() }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: badAssets },
    fetch: mockFetch([]),
  });
  assert.equal(response.status, 422);
});

// --- real file-backed contract (posts.json <-> pages on disk) ---------------

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

test('blog list page loads posts and renders newest first', () => {
  const html = readFileSync(`${publicDir}blog/index.html`, 'utf8');
  assert.match(html, /fetch\("\/blog\/posts\.json"/);
  assert.match(html, /String\(b\.date \|\| ""\)\.localeCompare\(String\(a\.date \|\| ""\)\)/);
  assert.match(html, /href="\/blog\/\$\{encodeURIComponent\(post\.slug\)\}"/);
});

test('every post in the real posts.json is complete and loadable', () => {
  const manifest = JSON.parse(readFileSync(`${publicDir}blog/posts.json`, 'utf8'));
  assert.ok(Array.isArray(manifest.posts) && manifest.posts.length > 0, 'posts.json must list at least one post');

  for (const post of manifest.posts) {
    // metadata
    assert.ok(post.slug && /^[a-z0-9-]+$/.test(post.slug), `invalid slug: ${JSON.stringify(post.slug)}`);
    assert.ok(post.title && String(post.title).trim(), `post "${post.slug}" is missing a title`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(post.date || ''), `post "${post.slug}" has a missing/invalid date`);

    // page exists
    const pagePath = `${publicDir}blog/${post.slug}/index.html`;
    assert.ok(existsSync(pagePath), `post "${post.slug}" has no index.html`);
    const html = readFileSync(pagePath, 'utf8');

    // non-empty body, proven through the real BlogPost the email uses
    const body = new BlogPost({ slug: post.slug, title: post.title, rawHtml: html }).body();
    assert.ok(body.length > 0, `post "${post.slug}" extracted to an empty body`);

    // every post carries the events CTA
    assert.match(html, /href="\/events"/, `post "${post.slug}" is missing the /events CTA`);

    // local image references resolve on disk
    for (const match of html.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/gi)) {
      const src = match[1];
      if (src.startsWith('/')) {
        assert.ok(existsSync(`${publicDir}${src.slice(1)}`), `post "${post.slug}" references a missing image: ${src}`);
      }
    }
  }
});

test('unsupported methods are not allowed (405 advertising GET + POST)', async () => {
  const response = await onRequest();
  assert.equal(response.status, 405);
});

// --- send-log read (admin UI) ----------------------------------------------

function sendLogRequest({ cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  return new Request('https://hackthevalley.org/api/blog/broadcast', { method: 'GET', headers });
}

test('GET send-log rejects non-admins with 401', async () => {
  const response = await onRequestGet({ request: sendLogRequest(), env: { HTV_DB: adminDb() } });
  assert.equal(response.status, 401);
});

test('GET send-log returns the recorded blasts for an admin', async () => {
  const store = new Map();
  store.set('k1', {
    idempotency_key: 'k1', slug: 'test-post', scheduled_at: '2026-07-01T00:00:00.000Z',
    broadcast_id: 'bc_1', status: 'sent', error: null,
    last_reconciled_at: '2026-07-01T00:05:00.000Z', created_at: 'c', updated_at: 'u',
  });
  const response = await onRequestGet({
    request: sendLogRequest({ cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb({ store }) },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.sends.length, 1);
  assert.equal(body.sends[0].slug, 'test-post');
  assert.equal(body.sends[0].status, 'sent');
  assert.equal(body.sends[0].broadcastId, 'bc_1');
});
