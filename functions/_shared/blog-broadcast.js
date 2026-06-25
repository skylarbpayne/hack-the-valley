// Pure, testable helpers for turning a published blog post into a Resend
// broadcast (email blast). The route handler in functions/api/blog/broadcast.js
// wires these together with admin auth and the ASSETS binding.

const POST_START = '<!-- POST:START -->';
const POST_END = '<!-- POST:END -->';

function httpError(message, status, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

// Email blasts must never go out immediately: a stray click would email the
// whole list with no take-back. Require a future send time with a buffer so an
// accidental "now" is impossible. Returns the normalized ISO timestamp.
export const SCHEDULE_BUFFER_MS = 10 * 60 * 1000;

export function normalizeScheduledAt(scheduledAt, { now = Date.now(), bufferMs = SCHEDULE_BUFFER_MS } = {}) {
  if (scheduledAt == null || String(scheduledAt).trim() === '') {
    throw httpError('A scheduled send time is required — blasts cannot be sent immediately.', 422);
  }
  const when = new Date(scheduledAt);
  const ts = when.getTime();
  if (Number.isNaN(ts)) {
    throw httpError('The scheduled send time is not a valid date/time.', 422);
  }
  if (ts < now + bufferMs) {
    const minutes = Math.round(bufferMs / 60000);
    throw httpError(`The scheduled send time must be at least ${minutes} minutes in the future.`, 422);
  }
  return when.toISOString();
}

// Idempotency key for a blast: one send per (post, scheduled time). A retry with
// the same slug + time collides on this key, so we never create a second blast.
export function broadcastIdempotencyKey(slug, scheduledAtIso) {
  return `${String(slug)}::${String(scheduledAtIso)}`;
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// Pull the article body out of a post page, using the markers every post carries.
export function extractPostContent(html) {
  const source = String(html || '');
  const startIdx = source.indexOf(POST_START);
  const endIdx = source.indexOf(POST_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw httpError('Post is missing its <!-- POST:START -->/<!-- POST:END --> markers.', 422);
  }
  const content = source.slice(startIdx + POST_START.length, endIdx).trim();
  if (!content) {
    throw httpError('Post content between the markers is empty.', 422);
  }
  return content;
}

// Rewrite root-relative src/href ("/images/...") to absolute URLs so they
// resolve in an email client. Leaves protocol-relative and absolute URLs alone.
export function absolutizeUrls(html, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return String(html || '');
  return String(html || '').replace(/(\s(?:src|href))="\/(?!\/)/g, `$1="${base}/`);
}

// Email clients ignore <style>/Tailwind, so any sizing the web page relied on
// is gone. Inline a width constraint on every image (otherwise full-resolution
// screenshots overflow the email width) and lightly style figure captions.
export function styleContentForEmail(html) {
  return String(html || '')
    .replace(
      /<img\b(?![^>]*\sstyle=)([^>]*)>/gi,
      '<img style="max-width:100%;height:auto;display:block;margin:16px auto;border-radius:8px;border:1px solid #e2e8f0;"$1>'
    )
    .replace(
      /<figcaption\b(?![^>]*\sstyle=)([^>]*)>/gi,
      '<figcaption style="font-size:13px;color:#64748b;text-align:center;margin-top:6px;"$1>'
    );
}

// Build an email-friendly HTML document. Email clients ignore <style>/Tailwind,
// so the chrome uses inline styles; the post body keeps its semantic tags.
export function buildBroadcastEmailHtml({ title, contentHtml, postUrl, eventsUrl } = {}) {
  const safeTitle = escapeHtml(title || 'Hack the Valley');
  const body = styleContentForEmail(contentHtml);
  const wrapperStyle = 'font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.6;';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;${wrapperStyle}">
    <div style="border-bottom:2px solid #06b6d4;padding-bottom:12px;margin-bottom:24px;">
      <span style="font-size:14px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#2563eb;">Hack the Valley</span>
    </div>
    <h1 style="font-size:26px;font-weight:800;margin:0 0 20px;color:#0f172a;">${safeTitle}</h1>
    <div style="font-size:16px;color:#334155;">
      ${body}
    </div>
    <div style="margin:32px 0;padding:24px;background:#0f172a;border-radius:12px;text-align:center;">
      <p style="margin:0 0 14px;color:#e2e8f0;font-size:16px;">Don't miss the next one.</p>
      <a href="${escapeAttr(eventsUrl || '#')}" style="display:inline-block;background:#06b6d4;color:#0f172a;font-weight:bold;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:16px;">Sign up for our next event</a>
    </div>
    <p style="font-size:13px;color:#64748b;">
      ${postUrl ? `Read this on the web: <a href="${escapeAttr(postUrl)}" style="color:#2563eb;">${escapeHtml(postUrl)}</a><br>` : ''}
      You're receiving this because you joined the Hack the Valley updates list.
      <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#64748b;">Unsubscribe</a>.
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

// Resolve the broadcast settings from env. Throws a 503 (not configured) if a
// required value is missing, matching how the mailing-list sync behaves.
// Note: the audience is resolved separately (see resolveAudienceId) so the
// common "send to my one list" case needs no audience config.
export function resolveBroadcastConfig(env = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const from = String(env.RESEND_BROADCAST_FROM || env.RESEND_FROM || env.RESEND_FROM_EMAIL || '').trim();
  const missing = [];
  if (!apiKey) missing.push('RESEND_API_KEY');
  if (!from) missing.push('RESEND_BROADCAST_FROM');
  if (missing.length) {
    throw httpError(`Email blasts are not configured. Missing: ${missing.join(', ')}.`, 503);
  }
  return { apiKey, from };
}

// Resolve which Resend audience (email list) the broadcast goes to. Prefer an
// explicit RESEND_AUDIENCE_ID; otherwise auto-discover when the account has
// exactly one audience, so "send to the whole list" needs no extra config.
// Refuse to guess when several audiences exist, to avoid emailing the wrong one.
export async function resolveAudienceId({ env = {}, fetcher = fetch } = {}) {
  const explicit = String(env.RESEND_AUDIENCE_ID || '').trim();
  if (explicit) return explicit;

  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const response = await fetcher('https://api.resend.com/audiences', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw httpError(`Could not list Resend audiences (HTTP ${response.status}). Set RESEND_AUDIENCE_ID to target a list.`, 502);
  }
  const payload = await response.json().catch(() => ({}));
  const audiences = payload?.data || payload?.audiences || [];
  if (!audiences.length) {
    throw httpError('No Resend audience found to send to. Create one in Resend, or set RESEND_AUDIENCE_ID.', 503);
  }
  if (audiences.length > 1) {
    const names = audiences.map((audience) => audience.name || audience.id).join(', ');
    throw httpError(`Multiple Resend audiences exist (${names}). Set RESEND_AUDIENCE_ID to choose which list to email.`, 409);
  }
  return audiences[0].id;
}

// Create a Resend broadcast targeting the configured audience, then send it.
export async function createAndSendBroadcast({
  env = {},
  fetcher = fetch,
  audienceId,
  from,
  subject,
  name,
  html,
  scheduledAt = null,
} = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const createResponse = await fetcher('https://api.resend.com/broadcasts', {
    method: 'POST',
    headers,
    body: JSON.stringify({ audience_id: audienceId, from, subject, name, html }),
  });
  if (!createResponse.ok) {
    throw httpError(`Resend broadcast create failed with HTTP ${createResponse.status}: ${await readResponseText(createResponse)}`, 502);
  }
  const created = await createResponse.json().catch(() => ({}));
  const broadcastId = created?.id || created?.data?.id;
  if (!broadcastId) {
    throw httpError('Resend broadcast create returned no id.', 502);
  }

  const sendResponse = await fetcher(`https://api.resend.com/broadcasts/${encodeURIComponent(broadcastId)}/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify(scheduledAt ? { scheduled_at: scheduledAt } : {}),
  });
  if (!sendResponse.ok) {
    // The broadcast was created but scheduling/sending failed. Surface the real
    // broadcastId so recovery acts on it instead of guessing or re-creating.
    throw httpError(
      `Resend broadcast send failed with HTTP ${sendResponse.status}: ${await readResponseText(sendResponse)}`,
      502,
      { broadcastId },
    );
  }

  return { id: broadcastId, scheduled: Boolean(scheduledAt) };
}

// Our local status for a row given Resend's broadcast status. A scheduled send
// passes through Resend states draft -> scheduled -> queued -> sent; canceling a
// scheduled broadcast reverts it to draft. There is no Resend "failed" broadcast
// status, so the only terminal outcomes are "sent" and "canceled". Returns null
// for anything we don't recognize so the caller leaves the row untouched.
export function mapResendBroadcastStatus(resendStatus) {
  switch (String(resendStatus || '').toLowerCase()) {
    case 'sent':
      return 'sent';
    case 'queued':
      return 'sending';
    case 'scheduled':
      return 'scheduled';
    case 'draft':
      // A send we'd already handed to Resend is only "draft" again if its
      // schedule was canceled — treat that as a terminal cancellation.
      return 'canceled';
    default:
      return null;
  }
}

// Fetch a single broadcast's current status from Resend. Returns
// { found: false } on a 404 (broadcast deleted), { found: true, status } on
// success, and throws on a transient error so the caller can retry later.
export async function fetchBroadcastStatus({ env = {}, fetcher = fetch, broadcastId } = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const response = await fetcher(`https://api.resend.com/broadcasts/${encodeURIComponent(broadcastId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (response.status === 404) return { found: false, status: null };
  if (!response.ok) {
    throw httpError(`Could not fetch Resend broadcast ${broadcastId} (HTTP ${response.status}).`, 502);
  }
  const payload = await response.json().catch(() => ({}));
  return { found: true, status: payload?.status || payload?.data?.status || null };
}

// Reconcile non-terminal send-log rows against Resend's real broadcast status.
// Designed to be called from a scheduled (cron) handler: it polls each row that
// is still scheduled/sending and advances it toward a terminal state. One row's
// failure never aborts the batch — transient errors leave the row for next time.
export async function reconcileBroadcastSends({ db, env = {}, fetcher = fetch } = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) return { checked: 0, updated: 0, errors: 0, skipped: 'no-api-key' };

  const query = await db
    .prepare(
      `SELECT id, broadcast_id, status FROM blog_broadcast_sends
       WHERE status IN ('scheduled', 'sending') AND broadcast_id IS NOT NULL`
    )
    .all();
  const rows = query?.results || [];

  let checked = 0;
  let updated = 0;
  let errors = 0;
  for (const row of rows) {
    checked += 1;
    try {
      const { found, status } = await fetchBroadcastStatus({ env, fetcher, broadcastId: row.broadcast_id });
      const next = found ? mapResendBroadcastStatus(status) : 'canceled';
      const checkedAt = new Date().toISOString();
      if (next && next !== row.status) {
        await db
          .prepare(
            `UPDATE blog_broadcast_sends SET status = ?, last_reconciled_at = ?, updated_at = ? WHERE id = ?`
          )
          .bind(next, checkedAt, checkedAt, row.id)
          .run();
        updated += 1;
      } else {
        // No change (still scheduled/sending, or an unrecognized status): just
        // record that we checked so monitoring can see liveness.
        await db
          .prepare('UPDATE blog_broadcast_sends SET last_reconciled_at = ? WHERE id = ?')
          .bind(checkedAt, row.id)
          .run();
      }
    } catch {
      // Transient (network / 5xx): leave the row as-is to retry next run.
      errors += 1;
    }
  }
  return { checked, updated, errors };
}
