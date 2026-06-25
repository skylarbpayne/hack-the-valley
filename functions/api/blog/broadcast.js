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
  broadcastIdempotencyKey,
  buildBroadcastEmailHtml,
  createAndSendBroadcast,
  extractPostContent,
  normalizeScheduledAt,
  resolveAudienceId,
  resolveBroadcastConfig,
} from '../../_shared/blog-broadcast.js';

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

    // Real send: never immediate. Require a valid, future scheduled time.
    const scheduledAt = normalizeScheduledAt(input.scheduledAt);

    const fetcher = context.fetch || fetch;
    const config = resolveBroadcastConfig(env);

    // Resolve the target audience BEFORE reserving the row. This is a read-only
    // lookup that creates nothing at Resend, so doing it first means an audience
    // misconfiguration (no/ambiguous audience) fails the request without leaving
    // behind a 'pending' row — which would otherwise block every future retry on
    // the idempotency key even after the config is fixed.
    const audienceId = await resolveAudienceId({ env, fetcher });

    // Reserve this blast before touching Resend. The UNIQUE idempotency key
    // means a retry with the same slug + scheduled time collides here instead
    // of creating a second broadcast.
    const db = getDb(env);
    const key = broadcastIdempotencyKey(slug, scheduledAt);
    const reservedAt = new Date().toISOString();
    try {
      await db
        .prepare(
          `INSERT INTO blog_broadcast_sends (idempotency_key, slug, scheduled_at, status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`
        )
        .bind(key, slug, scheduledAt, reservedAt, reservedAt)
        .run();
    } catch {
      const existing = await db
        .prepare('SELECT broadcast_id, status FROM blog_broadcast_sends WHERE idempotency_key = ?')
        .bind(key)
        .first();
      throw httpError(
        `A blast for "${slug}" scheduled at ${scheduledAt} was already submitted (status: ${existing?.status || 'unknown'}).`,
        409,
        existing?.broadcast_id ? { broadcastId: existing.broadcast_id } : undefined,
      );
    }

    let result;
    try {
      result = await createAndSendBroadcast({
        env,
        fetcher,
        audienceId,
        from: config.from,
        subject,
        name: `Blog: ${post.title || slug}`,
        html: emailHtml,
        scheduledAt,
      });
    } catch (err) {
      const finishedAt = new Date().toISOString();
      if (err && err.broadcastId) {
        // Create succeeded, send/schedule failed: keep the reservation and the
        // real broadcastId so the next attempt is blocked and recovery is exact.
        await db
          .prepare(
            `UPDATE blog_broadcast_sends SET broadcast_id = ?, status = 'send_failed', error = ?, updated_at = ?
             WHERE idempotency_key = ?`
          )
          .bind(err.broadcastId, String(err.message || err).slice(0, 500), finishedAt, key)
          .run();
      } else {
        // Nothing was created at Resend: release the reservation so a clean retry
        // is allowed.
        await db.prepare('DELETE FROM blog_broadcast_sends WHERE idempotency_key = ?').bind(key).run();
      }
      throw err;
    }

    // Resend has only *accepted* the scheduled send — it hasn't gone out yet
    // (and could still fail at send time). Record 'scheduled', not 'sent'; the
    // reconcile cron advances this to sending/sent/canceled from Resend's real
    // broadcast status. Writing 'sent' here would be a lie that never self-corrects.
    await db
      .prepare(
        `UPDATE blog_broadcast_sends SET broadcast_id = ?, status = 'scheduled', updated_at = ? WHERE idempotency_key = ?`
      )
      .bind(result.id, new Date().toISOString(), key)
      .run();

    return jsonResponse({
      ok: true,
      slug,
      subject,
      scheduledAt,
      broadcastId: result.id,
      scheduled: result.scheduled,
      status: 'scheduled',
    });
  });
}

// GET /api/blog/broadcast — admin-only. Returns the recent blast send-log so the
// organizer page can show each blast's reconciled status (the cron keeps these
// rows honest: scheduled -> sending -> sent/canceled).
export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const query = await db
      .prepare(
        `SELECT slug, scheduled_at, broadcast_id, status, error, last_reconciled_at, created_at, updated_at
         FROM blog_broadcast_sends
         ORDER BY scheduled_at DESC
         LIMIT 50`
      )
      .all();
    return jsonResponse({ ok: true, sends: query?.results || [] });
  });
}

export async function onRequest() {
  return methodNotAllowed(['GET', 'POST']);
}
