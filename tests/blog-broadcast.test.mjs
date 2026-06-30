import test from 'node:test';
import assert from 'node:assert/strict';

import {
  absolutizeUrls,
  buildBroadcastEmailHtml,
  createAndSendBroadcast,
  extractPostContent,
  resolveAudienceId,
  resolveBroadcastConfig,
} from '../functions/_shared/blog-broadcast.js';
import { onRequestPost, onRequest } from '../functions/api/blog/broadcast.js';

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

// Mirrors the role-aware mock DB used in event-platform.test.mjs.
function adminDb({ role = 'admin' } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM user_sessions/.test(sql)) {
            return { id: 'usr_admin', email: 'admin@example.com', name: 'Admin', session_id: 'ses', session_expires_at: '2099-01-01T00:00:00.000Z' };
          }
          if (/FROM roles/.test(sql)) {
            return role && this.args.includes(role) ? { role, scope_type: 'global', scope_id: '*', created_at: '2026-01-01T00:00:00.000Z' } : null;
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() { return { results: [] }; },
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

test('extractPostContent returns the body between the markers', () => {
  const content = extractPostContent(POST_HTML);
  assert.match(content, /Hello world/);
  assert.doesNotMatch(content, /CTA chrome/);
  assert.doesNotMatch(content, /<title>/);
});

test('extractPostContent throws 422 when markers are missing', () => {
  assert.throws(() => extractPostContent('<p>no markers</p>'), (err) => err.status === 422);
});

test('absolutizeUrls rewrites root-relative URLs and leaves absolute ones', () => {
  const out = absolutizeUrls('<img src="/images/x.png"><a href="https://x.com">e</a><img src="//cdn/y">', 'https://hackthevalley.org');
  assert.match(out, /src="https:\/\/hackthevalley\.org\/images\/x\.png"/);
  assert.match(out, /href="https:\/\/x\.com"/);
  assert.match(out, /src="\/\/cdn\/y"/);
});

test('buildBroadcastEmailHtml includes title, CTA to events, and unsubscribe token', () => {
  const html = buildBroadcastEmailHtml({
    title: 'My Post',
    contentHtml: '<p>body</p>',
    postUrl: 'https://hackthevalley.org/blog/my-post',
    eventsUrl: 'https://hackthevalley.org/events',
  });
  assert.match(html, /My Post/);
  assert.match(html, /<p>body<\/p>/);
  assert.match(html, /Sign up for our next event/);
  assert.match(html, /href="https:\/\/hackthevalley\.org\/events"/);
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
});

test('resolveAudienceId prefers explicit id, auto-discovers one audience, or chooses the whole-list audience', async () => {
  assert.equal(await resolveAudienceId({ env: { RESEND_AUDIENCE_ID: 'aud_x' } }), 'aud_x');
  const oneAudience = mockFetch([{ status: 200, body: { data: [{ id: 'aud_solo', name: 'HTV list' }] } }]);
  assert.equal(await resolveAudienceId({ env: { RESEND_API_KEY: 'k' }, fetcher: oneAudience }), 'aud_solo');
  const manyWithGeneral = mockFetch([{ status: 200, body: { data: [{ id: 'aud_event', name: 'Hack the Valley 2026' }, { id: 'aud_general', name: 'General' }] } }]);
  assert.equal(await resolveAudienceId({ env: { RESEND_API_KEY: 'k' }, fetcher: manyWithGeneral }), 'aud_general');
});

test('resolveAudienceId refuses to guess when multiple audiences have no whole-list audience', async () => {
  const many = mockFetch([{ status: 200, body: { data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } }]);
  await assert.rejects(resolveAudienceId({ env: { RESEND_API_KEY: 'k' }, fetcher: many }), (err) => err.status === 409);
});

test('resolveAudienceId errors when there are no audiences', async () => {
  const none = mockFetch([{ status: 200, body: { data: [] } }]);
  await assert.rejects(resolveAudienceId({ env: { RESEND_API_KEY: 'k' }, fetcher: none }), (err) => err.status === 503);
});

test('createAndSendBroadcast creates then sends with the right payloads', async () => {
  const calls = [];
  const fetcher = mockFetch([{ status: 200, body: { id: 'bc_123' } }, { status: 200, body: { id: 'bc_123' } }], calls);
  const result = await createAndSendBroadcast({
    env: { RESEND_API_KEY: 'k' }, fetcher,
    audienceId: 'aud_1', from: 'HTV <a@b.co>', subject: 'Hi', name: 'Blog: x', html: '<p>e</p>',
  });
  assert.equal(result.id, 'bc_123');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.resend.com/broadcasts');
  const createBody = JSON.parse(calls[0].init.body);
  assert.equal(createBody.audience_id, 'aud_1');
  assert.equal(createBody.from, 'HTV <a@b.co>');
  assert.equal(calls[1].url, 'https://api.resend.com/broadcasts/bc_123/send');
});

test('createAndSendBroadcast throws 502 if create fails', async () => {
  const fetcher = mockFetch([{ status: 400, body: { message: 'bad' } }]);
  await assert.rejects(
    createAndSendBroadcast({ env: { RESEND_API_KEY: 'k' }, fetcher, audienceId: 'a', from: 'f', subject: 's', html: 'h' }),
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
  // image rewritten to absolute for email clients
  assert.match(body.html, /src="https:\/\/hackthevalley\.org\/images\/blog\/x\.png"/);
  assert.equal(calls.length, 0, 'dry run must not hit Resend');
});

test('handler sends a broadcast for an admin', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', subject: 'Custom subject' }, { cookie: 'htv_session=tok' }),
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
  assert.equal(body.scheduled, false);
  assert.equal(calls.length, 2);
});

test('handler schedules a broadcast when scheduledAt is provided', async () => {
  const calls = [];
  const scheduledAt = '2026-07-04T18:30:00.000Z';
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post', scheduledAt }, { cookie: 'htv_session=tok' }),
    env: {
      HTV_DB: adminDb(), ASSETS: assets(),
      RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1', RESEND_BROADCAST_FROM: 'HTV <a@b.co>',
    },
    fetch: mockFetch([{ status: 200, body: { id: 'bc_scheduled' } }, { status: 200, body: { id: 'bc_scheduled' } }], calls),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.scheduled, true);
  assert.equal(body.broadcastId, 'bc_scheduled');
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].init.body), { scheduled_at: scheduledAt });
});

test('handler auto-discovers the General audience when multiple audiences exist', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: broadcastRequest({ slug: 'test-post' }, { cookie: 'htv_session=tok' }),
    env: {
      HTV_DB: adminDb(), ASSETS: assets(),
      RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>', // no RESEND_AUDIENCE_ID
    },
    fetch: mockFetch([
      { status: 200, body: { data: [{ id: 'aud_event', name: 'Hack the Valley 2026' }, { id: 'aud_general', name: 'General' }] } }, // GET /audiences
      { status: 200, body: { id: 'bc_1' } }, // POST /broadcasts
      { status: 200, body: { id: 'bc_1' } }, // POST /broadcasts/:id/send
    ], calls),
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'https://api.resend.com/audiences');
  const createBody = JSON.parse(calls[1].init.body);
  assert.equal(createBody.audience_id, 'aud_general');
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
    request: broadcastRequest({ slug: 'test-post' }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: assets() },
    fetch: mockFetch([]),
  });
  assert.equal(response.status, 503);
});

test('GET is not allowed', async () => {
  const response = await onRequest();
  assert.equal(response.status, 405);
});
