import {
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
} from '../../_lib/event-platform.js';
import {
  absolutizeUrls,
  buildBroadcastEmailHtml,
  createAndSendBroadcast,
  extractPostContent,
  resolveAudienceId,
  resolveBroadcastConfig,
} from '../../_shared/blog-broadcast.js';

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
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
  const manifest = await response.json().catch(() => ({}));
  const posts = Array.isArray(manifest.posts) ? manifest.posts : [];
  const post = posts.find((entry) => entry && entry.slug === slug);
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

// POST /api/blog/broadcast  { slug, subject?, scheduledAt?, dryRun? }
// Admin-only. Turns a published post into a Resend broadcast and sends it.
// Pass dryRun:true to get the rendered email back without sending.
export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const { request, env } = context;

    const input = await readJson(request);
    const slug = String(input.slug || '').trim();
    if (!slug) {
      throw httpError('A post slug is required.', 400);
    }

    const base = baseUrl(request, env);
    const post = await loadManifestPost(env, request, slug);
    const contentHtml = await loadPostContent(env, request, slug, base);

    const subject = String(input.subject || post.title || 'Hack the Valley update').trim().slice(0, 200);
    const emailHtml = buildBroadcastEmailHtml({
      title: post.title || subject,
      contentHtml,
      postUrl: `${base}/blog/${encodeURIComponent(slug)}`,
      eventsUrl: `${base}/events`,
    });

    if (input.dryRun) {
      return jsonResponse({ ok: true, dryRun: true, slug, subject, html: emailHtml });
    }

    const fetcher = context.fetch || fetch;
    const config = resolveBroadcastConfig(env);
    const audienceId = await resolveAudienceId({ env, fetcher });
    const result = await createAndSendBroadcast({
      env,
      fetcher,
      audienceId,
      from: config.from,
      subject,
      name: `Blog: ${post.title || slug}`,
      html: emailHtml,
      scheduledAt: input.scheduledAt || null,
    });

    return jsonResponse({
      ok: true,
      slug,
      subject,
      broadcastId: result.id,
      scheduled: result.scheduled,
    });
  });
}

export async function onRequest() {
  return methodNotAllowed(['POST']);
}
