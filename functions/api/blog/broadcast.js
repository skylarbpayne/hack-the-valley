import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
} from '../../_lib/event-platform.js';
import { loadBlogPost } from '../../_lib/domain/blog-post.js';
import {
  createDraftBroadcast,
  listRecentSends,
} from '../../_lib/domain/blog-broadcast.js';

function httpError(message, status, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

function baseUrl(request, env) {
  return String(env.SITE_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
}

// POST /api/blog/broadcast  { slug, subject?, dryRun? }
// Admin-only. Loads the published post, renders the email, and creates a Resend
// draft. This route deliberately has no send/schedule mode.
export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const { request, env } = context;

    const input = await readJson(request);
    const slug = String(input.slug || '').trim();
    if (!slug) {
      throw httpError('A post slug is required.', 400);
    }

    const post = await loadBlogPost(env.ASSETS, slug, { origin: new URL(request.url).origin });
    const base = baseUrl(request, env);
    const subject = post.subjectLine(input.subject);
    const html = post.toEmailHtml({ baseUrl: base });

    if (input.dryRun) {
      return jsonResponse({ ok: true, dryRun: true, slug: post.slug, subject, html });
    }

    const result = await createDraftBroadcast({
      slug: post.slug,
      subject,
      name: post.broadcastName(),
      html,
      env,
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
