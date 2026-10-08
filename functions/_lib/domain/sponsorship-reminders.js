const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
const pacificDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function pacificDate(now = new Date()) {
  const parts = Object.fromEntries(pacificDateFormatter.formatToParts(new Date(now))
    .map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isOverdue(motion, today = pacificDate()) {
  return Boolean(motion.follow_up_on && motion.follow_up_on < today
    && !motion.follow_up_completed_at
    && !(motion.campaign_archived_at ?? motion.archived_at)
    && !['lost', 'paid'].includes(motion.status));
}

// Both the weekly review and notifications consume the same overdue rule above.
// EXISTS avoids duplicate reminders when a user has both eligible global roles.
export async function listReminderPreviews(db, { now = new Date(), origin = 'http://localhost:8788' } = {}) {
  const today = pacificDate(now);
  const { results = [] } = await db.prepare(`
    SELECT m.*, c.business_name, ca.name AS campaign_name,
      ca.archived_at AS campaign_archived_at, u.email AS owner_email, u.name AS owner_name
    FROM sponsorship_motions m
    JOIN sponsor_contacts c ON c.id = m.contact_id
    JOIN sponsorship_campaigns ca ON ca.id = m.campaign_id
    JOIN users u ON u.id = m.owner_user_id
    WHERE EXISTS (
      SELECT 1 FROM roles r WHERE r.user_id = u.id
        AND r.role IN ('admin', 'super_admin')
        AND r.scope_type = 'global' AND r.scope_id = '*' AND r.revoked_at IS NULL
    )
    ORDER BY m.owner_user_id, m.follow_up_on, c.business_name, m.id
  `).all();
  const groups = new Map();
  for (const motion of results) {
    if (!isOverdue(motion, today)) continue;
    if (!groups.has(motion.owner_user_id)) groups.set(motion.owner_user_id, []);
    groups.get(motion.owner_user_id).push(motion);
  }
  return [...groups.entries()].map(([ownerId, motions]) => renderDigest(ownerId, motions, today, origin));
}

function renderDigest(ownerId, motions, today, origin) {
  const items = motions.map((motion) => {
    const url = new URL('/admin-sponsorships', origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Reminder origin must use HTTP or HTTPS.');
    url.searchParams.set('motion', motion.id);
    return {
      id: motion.id, business_name: motion.business_name, campaign_name: motion.campaign_name,
      next_action: motion.next_action || 'Set a next action', follow_up_on: motion.follow_up_on,
      days_overdue: Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${motion.follow_up_on}T00:00:00Z`)) / 86_400_000),
      url: url.href,
    };
  });
  const subject = `${items.length} overdue sponsorship follow-up${items.length === 1 ? '' : 's'}`;
  const bodyText = `${subject}\nAs of ${today} (Pacific)\n\n${items.map((item) =>
    `${item.business_name} — ${item.campaign_name}\n${item.days_overdue} day${item.days_overdue === 1 ? '' : 's'} overdue (due ${item.follow_up_on})\nNext action: ${item.next_action}\n${item.url}`
  ).join('\n\n')}\n\nPreview only. No email has been sent.`;
  const bodyHtml = `<h1>${escapeHtml(subject)}</h1><p>As of ${escapeHtml(today)} (Pacific)</p><ul>${items.map((item) =>
    `<li><strong>${escapeHtml(item.business_name)}</strong> — ${escapeHtml(item.campaign_name)}<br>${item.days_overdue} day${item.days_overdue === 1 ? '' : 's'} overdue (due ${escapeHtml(item.follow_up_on)})<br>Next action: ${escapeHtml(item.next_action)}<br><a href="${escapeHtml(item.url)}">Open sponsorship</a></li>`
  ).join('')}</ul><p>Preview only. No email has been sent.</p>`;
  return {
    owner_user_id: ownerId, local_date: today, mode: 'preview', recipient: motions[0].owner_email,
    subject, body_html: bodyHtml, body_text: bodyText, motion_ids: items.map((item) => item.id), items,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

export async function captureReminderPreviews(db, { now = new Date(), origin } = {}) {
  const previews = await listReminderPreviews(db, { now, origin });
  const createdAt = new Date(now).toISOString();
  const items = [];
  let createdCount = 0;
  for (const preview of previews) {
    // The snapshot and its daily uniqueness key are one atomic SQL insert.
    // Do not update an existing row: the inbox preserves the original summary
    // while listReminderPreviews gives the current, read-only view of the work.
    const result = await db.prepare(`
      INSERT OR IGNORE INTO sponsorship_reminder_digests
        (id, owner_user_id, local_date, mode, recipient, subject, body_html, body_text, motion_ids_json, status, created_at)
      VALUES (?, ?, ?, 'preview', ?, ?, ?, ?, ?, 'preview', ?)
    `).bind(`srd_${crypto.randomUUID()}`, preview.owner_user_id, preview.local_date,
      preview.recipient, preview.subject, preview.body_html, preview.body_text,
      JSON.stringify(preview.motion_ids), createdAt).run();
    createdCount += Number(result.meta?.changes || 0);
    const stored = await db.prepare(`
      SELECT * FROM sponsorship_reminder_digests
      WHERE owner_user_id = ? AND local_date = ? AND mode = 'preview'
    `).bind(preview.owner_user_id, preview.local_date).first();
    if (stored) items.push(readDigest(stored));
  }
  return { items, created_count: createdCount };
}

export async function listReminderDigests(db) {
  const { results = [] } = await db.prepare(`
    SELECT * FROM sponsorship_reminder_digests
    ORDER BY local_date DESC, created_at DESC, id DESC
    LIMIT 200
  `).all();
  return results.map(readDigest);
}

function readDigest(row) {
  return { ...row, motion_ids: JSON.parse(row.motion_ids_json) };
}

export async function runScheduledSponsorshipReminders(db, { env = {}, scheduledTime = Date.now() } = {}) {
  if (env.SPONSORSHIP_REMINDERS_MODE !== 'preview') return { items: [], created_count: 0 };
  const now = new Date(scheduledTime);
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TIME_ZONE, hour: '2-digit', hourCycle: 'h23',
  }).format(now);
  if (hour !== '09') return { items: [], created_count: 0 };
  return captureReminderPreviews(db, { now, origin: env.SITE_BASE_URL || 'http://localhost:8788' });
}
