import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
} from '../../_lib/event-platform.js';
import {
  absolutizeUrls,
  buildBroadcastEmailHtml,
  extractPostContent,
} from '../../_shared/blog-broadcast.js';
import {
  listRecentSends,
  scheduleBroadcast,
} from '../../_lib/domain/blog-broadcast.js';

function httpError(message, status, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

function baseUrl(request, env) {
  return String(env.SITE_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
}

async function fetchAsset(env, request, path) {
  if (!env.ASSETS?.fetch) {
    throw httpError('Static assets binding is unavailable.', 500);
  }
  const url = new URL(path, new URL(request.url).origin);
  return env.ASSETS.fetch(new Request(url.toString(), { headers: { Accept: '*/*' } }));
}

async function loadManifestPost(env, request, slug) {
  const response = await fetchAsset(env, request, '/blog/posts.json');
  if (!response || !response.ok) {
    throw httpError('Could not load the blog manifest (posts.json).', 502);
  }
  let manifest;
  try {
    manifest = await response.json();
  } catch {
    throw httpError('Blog manifest is invalid (posts.json could not be parsed).', 422);
  }
  if (!manifest || !Array.isArray(manifest.posts)) {
    throw httpError('Blog manifest is invalid (missing a "posts" array).', 422);
  }
  const post = manifest.posts.find((entry) => entry && entry.slug === slug);
  if (!post) {
    throw httpError(`No published post with slug "${slug}".`, 404);
  }
  return post;
}

async function loadPostContent(env, request, slug, base) {
  const response = await fetchAsset(env, request, `/blog/${encodeURIComponent(slug)}`);
  if (!response || !response.ok) {
    throw httpError(`Could not load the post page for "${slug}".`, 404);
  }
  const html = await response.text();
  return absolutizeUrls(extractPostContent(html), base);
}

// Turn a published post into the email blast's subject/name/html. This is the
// presentation/asset work that belongs at the web layer; the domain takes the
// finished email and owns sending + lifecycle.
async function renderPostEmail(context, slug, subjectInput) {
  const { request, env } = context;
  const base = baseUrl(request, env);
  const post = await loadManifestPost(env, request, slug);
  const contentHtml = await loadPostContent(env, request, slug, base);
  const subject = String(subjectInput || post.title || 'Hack the Valley update').trim().slice(0, 200);
  const html = buildBroadcastEmailHtml({
    title: post.title || subject,
    contentHtml,
    postUrl: `${base}/blog/${encodeURIComponent(slug)}`,
    eventsUrl: `${base}/events`,
  });
  return { post, subject, html };
}

// POST /api/blog/broadcast  { slug, subject?, scheduledAt?, dryRun? }
// Admin-only. Renders a published post into an email and hands it to the Blog
// Broadcast domain to schedule. Pass dryRun:true to get the rendered email back
// without sending.
export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);

    const input = await readJson(context.request);
    const slug = String(input.slug || '').trim();
    if (!slug) {
      throw httpError('A post slug is required.', 400);
    }

    const { post, subject, html } = await renderPostEmail(context, slug, input.subject);

    if (input.dryRun) {
      return jsonResponse({ ok: true, dryRun: true, slug, subject, html });
    }

    const result = await scheduleBroadcast(getDb(context.env), {
      slug,
      scheduledAt: input.scheduledAt,
      subject,
      name: `Blog: ${post.title || slug}`,
      html,
      env: context.env,
      fetcher: context.fetch || fetch,
    });

    return jsonResponse({ ok: true, subject, ...result });
  });
}

// GET /api/blog/broadcast — admin-only. Returns the recent blast send-log so the
// organizer page can show each blast's reconciled status (the cron keeps these
// rows honest: scheduled -> sending -> sent/canceled).
export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const sends = await listRecentSends(getDb(context.env));
    return jsonResponse({ ok: true, sends });
  });
}

export async function onRequest() {
  return methodNotAllowed(['GET', 'POST']);
}
