// Blog Broadcast domain: the one home for "an email blast of a blog post."
//
// It owns the blog_broadcast_sends table, the blast lifecycle, the idempotency
// rule, and all orchestration with Resend (the email provider). Routes and the
// cron call into here; they never touch the table or Resend directly. Pure
// presentation helpers (building the email HTML) live in
// functions/_shared/blog-broadcast.js — those are not domain concerns.
//
// Lifecycle (also documented in migration 0025):
//   pending     reserved, before Resend create
//   scheduled   Resend accepted the scheduled send (Resend status: "scheduled")
//   sending     Resend is delivering it now            (Resend status: "queued")
//   sent        Resend reports it actually sent (terminal)
//   canceled    schedule canceled / broadcast deleted  (terminal)
//   send_failed broadcast created at Resend (broadcast_id stored) but the send is
//               not confirmed — the send call returned non-2xx or threw. The
//               reconciler re-checks these against Resend: if the send actually
//               went through (lost response), it promotes the row to
//               sending/scheduled/sent; one Resend still shows as an unsent draft
//               stays send_failed for an operator to retry or cancel using the
//               stored broadcast_id. NOT a terminal state.
//
// broadcast_id is persisted as soon as create succeeds, before the send is
// attempted, so a thrown send can never create a duplicate on retry.

import { stringOrNull } from './shared.js';

export const BROADCAST_STATUS = Object.freeze({
  PENDING: 'pending',
  SCHEDULED: 'scheduled',
  SENDING: 'sending',
  SENT: 'sent',
  CANCELED: 'canceled',
  SEND_FAILED: 'send_failed',
});

function httpError(message, status, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// Map a stored row to the domain shape the API/UI consume (camelCase).
export function toBroadcastSend(row = {}) {
  if (!row) return null;
  return {
    slug: stringOrNull(row.slug),
    scheduledAt: stringOrNull(row.scheduled_at),
    broadcastId: stringOrNull(row.broadcast_id),
    status: stringOrNull(row.status),
    error: stringOrNull(row.error),
    lastReconciledAt: stringOrNull(row.last_reconciled_at),
    createdAt: stringOrNull(row.created_at),
    updatedAt: stringOrNull(row.updated_at),
  };
}

// --- domain rules ----------------------------------------------------------

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

// --- Resend configuration + orchestration ----------------------------------

// Resolve the broadcast settings from env. Throws a 503 (not configured) if a
// required value is missing, matching how the mailing-list sync behaves.
// Note: the audience is resolved separately (see resolveAudienceId) so the
// common "send to my one list" case needs no audience config.
// Blog broadcasts also carry a reply-to address because the email template asks
// recipients to reply with projects/stories to feature on the blog.
export function resolveBroadcastConfig(env = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const from = String(env.RESEND_BROADCAST_FROM || env.RESEND_FROM || env.RESEND_FROM_EMAIL || '').trim();
  const replyTo = String(env.RESEND_BROADCAST_REPLY_TO || env.RESEND_REPLY_TO || env.HTV_CONTACT_EMAIL || 'contact@hackthevalley.org').trim();
  const missing = [];
  if (!apiKey) missing.push('RESEND_API_KEY');
  if (!from) missing.push('RESEND_BROADCAST_FROM');
  if (missing.length) {
    throw httpError(`Email blasts are not configured. Missing: ${missing.join(', ')}.`, 503);
  }
  return { apiKey, from, replyTo };
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

// Create a Resend broadcast (a draft targeting the audience) and return its id.
// Deliberately separate from sending: the caller persists this id BEFORE it
// attempts the send, so a send that throws can't strand a created-but-unrecorded
// broadcast (which would otherwise be re-created on retry).
export async function createBroadcast({ env = {}, fetcher = fetch, audienceId, from, replyTo, subject, name, html } = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const body = { audience_id: audienceId, from, subject, name, html };
  if (replyTo) body.reply_to = [replyTo];
  const response = await fetcher('https://api.resend.com/broadcasts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw httpError(`Resend broadcast create failed with HTTP ${response.status}: ${await readResponseText(response)}`, 502);
  }
  const created = await response.json().catch(() => ({}));
  const broadcastId = created?.id || created?.data?.id;
  if (!broadcastId) {
    throw httpError('Resend broadcast create returned no id.', 502);
  }
  return broadcastId;
}

// Send (or schedule) an already-created broadcast.
export async function sendBroadcast({ env = {}, fetcher = fetch, broadcastId, scheduledAt = null } = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const response = await fetcher(`https://api.resend.com/broadcasts/${encodeURIComponent(broadcastId)}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(scheduledAt ? { scheduled_at: scheduledAt } : {}),
  });
  if (!response.ok) {
    throw httpError(`Resend broadcast send failed with HTTP ${response.status}: ${await readResponseText(response)}`, 502);
  }
  return { scheduled: Boolean(scheduledAt) };
}

// --- write side: schedule a blast ------------------------------------------

// Reserve, send, and record a blast for an already-rendered email. The caller
// (route) owns turning a blog post into `subject`/`name`/`html`; this owns the
// lifecycle: validate -> resolve audience (read-only) -> reserve row -> hand to
// Resend -> record the truthful status. Audience is resolved BEFORE the row is
// reserved so a misconfiguration can't orphan a forever-'pending' row.
export async function scheduleBroadcast(db, { slug, scheduledAt, subject, name, html, env = {}, fetcher = fetch } = {}) {
  const normalizedSlug = String(slug || '').trim();
  if (!normalizedSlug) throw httpError('A post slug is required.', 400);

  const scheduledAtIso = normalizeScheduledAt(scheduledAt);
  const { from, replyTo } = resolveBroadcastConfig(env);
  const audienceId = await resolveAudienceId({ env, fetcher });

  const key = broadcastIdempotencyKey(normalizedSlug, scheduledAtIso);
  const reservedAt = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO blog_broadcast_sends (idempotency_key, slug, scheduled_at, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`
      )
      .bind(key, normalizedSlug, scheduledAtIso, reservedAt, reservedAt)
      .run();
  } catch {
    const existing = await db
      .prepare('SELECT broadcast_id, status FROM blog_broadcast_sends WHERE idempotency_key = ?')
      .bind(key)
      .first();
    throw httpError(
      `A blast for "${normalizedSlug}" scheduled at ${scheduledAtIso} was already submitted (status: ${existing?.status || 'unknown'}).`,
      409,
      existing?.broadcast_id ? { broadcastId: existing.broadcast_id } : undefined,
    );
  }

  // Create the broadcast first. If create fails, nothing was created at Resend —
  // release the reservation so a clean retry is allowed.
  let broadcastId;
  try {
    broadcastId = await createBroadcast({ env, fetcher, audienceId, from, replyTo, subject, name, html });
  } catch (err) {
    await db.prepare('DELETE FROM blog_broadcast_sends WHERE idempotency_key = ?').bind(key).run();
    throw err;
  }

  // Persist broadcast_id BEFORE attempting the send. This closes the gap where a
  // send that *throws* (network drop, runtime error) — not just one that returns
  // a non-2xx response — would leave a created broadcast with no recorded id: the
  // reservation would look empty, get deleted, and a retry would create a
  // duplicate. With the id stored (status 'send_failed' until the send is
  // confirmed), a retry collides on the idempotency key (409 carrying the id) and
  // the reconciler can recover the row against Resend.
  await db
    .prepare(
      `UPDATE blog_broadcast_sends SET broadcast_id = ?, status = 'send_failed', updated_at = ? WHERE idempotency_key = ?`
    )
    .bind(broadcastId, new Date().toISOString(), key)
    .run();

  try {
    await sendBroadcast({ env, fetcher, broadcastId, scheduledAt: scheduledAtIso });
  } catch (err) {
    // The row is already 'send_failed' with the real id; just record the reason.
    // The reconciler re-checks send_failed rows against Resend's real status.
    await db
      .prepare('UPDATE blog_broadcast_sends SET error = ?, updated_at = ? WHERE idempotency_key = ?')
      .bind(String(err.message || err).slice(0, 500), new Date().toISOString(), key)
      .run();
    throw Object.assign(err, { broadcastId });
  }

  // Resend has only *accepted* the scheduled send — it hasn't gone out yet (and
  // could still fail at send time). Record 'scheduled', not 'sent'; the reconcile
  // cron advances this from Resend's real status. Writing 'sent' here would be a
  // lie that never self-corrects.
  await db
    .prepare(
      `UPDATE blog_broadcast_sends SET broadcast_id = ?, status = 'scheduled', updated_at = ? WHERE idempotency_key = ?`
    )
    .bind(broadcastId, new Date().toISOString(), key)
    .run();

  return {
    slug: normalizedSlug,
    scheduledAt: scheduledAtIso,
    broadcastId,
    scheduled: Boolean(scheduledAtIso),
    status: BROADCAST_STATUS.SCHEDULED,
  };
}

// --- read side -------------------------------------------------------------

// Recent blasts for the admin send-log, newest scheduled first.
export async function listRecentSends(db, { limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const query = await db
    .prepare(
      `SELECT slug, scheduled_at, broadcast_id, status, error, last_reconciled_at, created_at, updated_at
       FROM blog_broadcast_sends
       ORDER BY scheduled_at DESC
       LIMIT ?`
    )
    .bind(safeLimit)
    .all();
  return (query?.results || []).map(toBroadcastSend);
}

// --- reconciliation (cron) -------------------------------------------------

// Our local status for a row given Resend's broadcast status. A scheduled send
// passes through Resend states draft -> scheduled -> queued -> sent; canceling a
// scheduled broadcast reverts it to draft. There is no Resend "failed" broadcast
// status, so the only terminal outcomes are "sent" and "canceled". Returns null
// for anything we don't recognize so the caller leaves the row untouched.
export function mapResendBroadcastStatus(resendStatus) {
  switch (String(resendStatus || '').toLowerCase()) {
    case 'sent':
      return BROADCAST_STATUS.SENT;
    case 'queued':
      return BROADCAST_STATUS.SENDING;
    case 'scheduled':
      return BROADCAST_STATUS.SCHEDULED;
    case 'draft':
      // A send we'd already handed to Resend is only "draft" again if its
      // schedule was canceled — treat that as a terminal cancellation.
      return BROADCAST_STATUS.CANCELED;
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
// is still scheduled/sending/send_failed and advances it toward a terminal
// state. One row's failure never aborts the batch — transient errors leave the
// row for next time.
//
// send_failed rows are included so the row self-heals when our send call failed
// or threw but Resend actually accepted the send (a lost response): Resend then
// reports it scheduled/queued/sent and we promote it — which is what makes the
// "persist broadcast_id before send" safety net pay off. A send_failed row that
// Resend still shows as an unsent draft is left send_failed for an operator to
// retry or cancel (we don't auto-resend: its scheduled_at may now be in the
// past, and the "never send immediately" rule must hold).
export async function reconcileBroadcastSends(db, { env = {}, fetcher = fetch } = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) return { checked: 0, updated: 0, errors: 0, skipped: 'no-api-key' };

  const query = await db
    .prepare(
      `SELECT id, broadcast_id, status FROM blog_broadcast_sends
       WHERE status IN ('scheduled', 'sending', 'send_failed') AND broadcast_id IS NOT NULL`
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
      let next = found ? mapResendBroadcastStatus(status) : BROADCAST_STATUS.CANCELED;
      // 'draft' maps to canceled for a row we believed scheduled/sending (its
      // schedule was canceled). But a send_failed row that Resend still shows as
      // draft was created and never sent — leave it for explicit retry/cancel
      // rather than silently canceling it.
      if (next === BROADCAST_STATUS.CANCELED && found && row.status === BROADCAST_STATUS.SEND_FAILED) {
        next = null;
      }
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
