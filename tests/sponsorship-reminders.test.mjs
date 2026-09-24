import test from 'node:test';
import assert from 'node:assert/strict';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';

import {
  pacificDate, isOverdue, listReminderPreviews, captureReminderPreviews,
  listReminderDigests, runScheduledSponsorshipReminders,
} from '../functions/_lib/domain/sponsorship-reminders.js';

test('overdue means a past Pacific date on an unfinished, active, non-terminal motion', () => {
  const motion = { follow_up_on: '2026-09-23', status: 'contacted', follow_up_completed_at: null, campaign_archived_at: null };
  assert.equal(isOverdue(motion, '2026-09-24'), true);
  for (const change of [
    { follow_up_on: '2026-09-24' }, { follow_up_on: '2026-09-25' },
    { follow_up_on: null }, { follow_up_on: '' },
    { follow_up_completed_at: '2026-09-23T18:00:00Z' },
    { status: 'lost' }, { status: 'paid' },
    { campaign_archived_at: '2026-09-20T18:00:00Z' },
  ]) assert.equal(isOverdue({ ...motion, ...change }, '2026-09-24'), false, JSON.stringify(change));
  assert.equal(isOverdue({ ...motion, status: 'committed' }, '2026-09-24'), true);
});

test('Pacific calendar dates follow midnight and daylight saving changes', () => {
  assert.equal(pacificDate('2026-09-24T06:59:59Z'), '2026-09-23');
  assert.equal(pacificDate('2026-09-24T07:00:00Z'), '2026-09-24');
  assert.equal(pacificDate('2026-01-24T07:59:59Z'), '2026-01-23');
  assert.equal(pacificDate(new Date('2026-01-24T08:00:00Z')), '2026-01-24');
  assert.equal(pacificDate(Date.parse('2026-03-08T16:00:00Z')), '2026-03-08');
  assert.equal(pacificDate('2026-11-01T17:00:00Z'), '2026-11-01');
});

const NOW = '2026-09-24T16:00:00.000Z';
const ORIGIN = 'http://localhost:8788';
const eligible = {
  id: 'motion_a', owner_user_id: 'admin_a', owner_email: 'a@example.com', owner_name: 'Admin A',
  business_name: 'Sample business', campaign_name: 'HTV 2027', next_action: 'Call the contact',
  follow_up_on: '2026-09-22', follow_up_completed_at: null, campaign_archived_at: null,
  status: 'contacted',
};

function readOnlyFixtureDb(rows) {
  return { prepare: () => ({ all: async () => ({ results: rows }) }) };
}

test('live previews group only overdue items by owner across campaigns without persisting', async () => {
  const db = readOnlyFixtureDb([
    eligible,
    { ...eligible, id: 'motion_b', campaign_name: 'Summer workshop' },
    { ...eligible, id: 'motion_c', owner_user_id: 'admin_b', owner_email: 'b@example.com' },
    { ...eligible, id: 'today', follow_up_on: '2026-09-24' },
    { ...eligible, id: 'future', follow_up_on: '2026-09-25' },
    { ...eligible, id: 'complete', follow_up_completed_at: NOW },
    { ...eligible, id: 'lost', status: 'lost' },
    { ...eligible, id: 'paid', status: 'paid' },
    { ...eligible, id: 'archived', campaign_archived_at: NOW },
  ]);
  const previews = await listReminderPreviews(db, { now: NOW, origin: ORIGIN });
  assert.equal(previews.length, 2);
  assert.deepEqual(previews[0].motion_ids, ['motion_a', 'motion_b']);
  assert.deepEqual(previews[1].motion_ids, ['motion_c']);
  assert.equal(previews[0].recipient, 'a@example.com');
  assert.equal(previews[0].items[0].days_overdue, 2);
  assert.match(previews[0].body_text, /Summer workshop/);
  assert.match(previews[0].body_text, /Call the contact/);
  assert.match(previews[0].body_text, /http:\/\/localhost:8788\/admin-sponsorships\?motion=motion_a/);
});

test('reminder rendering escapes contact, campaign, and action text and safely encodes record links', async () => {
  const [preview] = await listReminderPreviews(readOnlyFixtureDb([{
    ...eligible, id: 'id&"<a>', business_name: '<script>alert("x")</script>',
    campaign_name: 'Spring & Summer', next_action: '<img src=x onerror=alert(1)>',
  }]), { now: NOW, origin: ORIGIN });
  assert.doesNotMatch(preview.body_html, /<script>|<img/);
  assert.match(preview.body_html, /&lt;script&gt;/);
  assert.match(preview.body_html, /Spring &amp; Summer/);
  assert.equal(new URL(preview.items[0].url).searchParams.get('motion'), 'id&"<a>');
});

test('no overdue tasks produce no live preview', async () => {
  assert.deepEqual(await listReminderPreviews(readOnlyFixtureDb([
    { ...eligible, follow_up_on: '2026-09-24' },
  ]), { now: NOW }), []);
});

test('scheduled reminders are disabled unless explicitly in preview mode and within 9am Pacific', async () => {
  const unavailableDb = { prepare() { throw new Error('Disabled job must not access database'); } };
  assert.equal((await runScheduledSponsorshipReminders(unavailableDb, { env: {}, scheduledTime: Date.parse(NOW) })).created_count, 0);
  assert.equal((await runScheduledSponsorshipReminders(unavailableDb, { env: { SPONSORSHIP_REMINDERS_MODE: 'send' }, scheduledTime: Date.parse(NOW) })).created_count, 0);
  for (const date of ['2026-09-24T15:59:00Z', '2026-09-24T17:00:00Z', '2026-01-24T16:59:00Z', '2026-01-24T18:00:00Z']) {
    assert.equal((await runScheduledSponsorshipReminders(unavailableDb, {
      env: { SPONSORSHIP_REMINDERS_MODE: 'preview' }, scheduledTime: Date.parse(date),
    })).created_count, 0);
  }
});

async function insertMotion(db, id, overrides = {}) {
  const row = {
    owner_user_id: DEMO_USERS.danny, campaign_id: 'campaign_main', status: 'contacted',
    follow_up_on: '2026-09-22', follow_up_completed_at: null, next_action: 'Make a call', ...overrides,
  };
  await db.prepare(`INSERT OR IGNORE INTO sponsorship_campaigns (id,name,year,created_at,updated_at)
    VALUES (?, ?, 2027, ?, ?)`).bind(row.campaign_id, row.campaign_id, NOW, NOW).run();
  await db.prepare(`INSERT INTO sponsor_contacts (id,business_name,created_at,updated_at)
    VALUES (?, ?, ?, ?)`).bind(`contact_${id}`, `Business ${id}`, NOW, NOW).run();
  await db.prepare(`INSERT INTO sponsorship_motions
    (id,contact_id,campaign_id,owner_user_id,status,follow_up_on,follow_up_completed_at,next_action,created_at,updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, `contact_${id}`, row.campaign_id, row.owner_user_id,
      row.status, row.follow_up_on, row.follow_up_completed_at, row.next_action, NOW, NOW).run();
}

test('database previews include only current global admins and do not duplicate an owner with two roles', async (t) => {
  const { db, close } = await createSponsorshipDb(); t.after(close);
  await insertMotion(db, 'danny');
  await insertMotion(db, 'alex', { owner_user_id: DEMO_USERS.alex });
  await insertMotion(db, 'member', { owner_user_id: DEMO_USERS.member });
  await db.prepare(`INSERT INTO roles (id,user_id,role,scope_type,scope_id,created_at)
    VALUES ('second_role',?,'admin','global','*',?)`).bind(DEMO_USERS.danny, NOW).run();
  await db.prepare(`INSERT INTO roles (id,user_id,role,scope_type,scope_id,created_at)
    VALUES ('event_role',?,'admin','event','hack-the-valley-2026',?)`).bind(DEMO_USERS.member, NOW).run();
  let previews = await listReminderPreviews(db, { now: NOW, origin: ORIGIN });
  assert.equal(previews.length, 2);
  assert.deepEqual(previews.find(p => p.owner_user_id === DEMO_USERS.danny).motion_ids, ['danny']);
  await db.prepare(`UPDATE roles SET revoked_at = ? WHERE user_id = ?`).bind(NOW, DEMO_USERS.alex).run();
  previews = await listReminderPreviews(db, { now: NOW });
  assert.equal(previews.length, 1);
  assert.equal(previews[0].recipient, 'danny@example.com');
  const captures = await captureReminderPreviews(db, { now: NOW });
  assert.equal(captures.created_count, 1);
  assert.equal(captures.items[0].owner_user_id, DEMO_USERS.danny);
});

test('concurrent capture retries persist one complete immutable snapshot per owner and Pacific day', async (t) => {
  const { db, close } = await createSponsorshipDb(); t.after(close);
  await insertMotion(db, 'danny');
  await insertMotion(db, 'alex', { owner_user_id: DEMO_USERS.alex });
  const captures = await Promise.all(Array.from({ length: 5 }, () => captureReminderPreviews(db, { now: NOW, origin: ORIGIN })));
  assert.equal(captures.reduce((sum, capture) => sum + capture.created_count, 0), 2);
  for (const capture of captures) assert.equal(capture.items.length, 2);
  let snapshots = await listReminderDigests(db);
  assert.equal(snapshots.length, 2);
  const original = snapshots.find(item => item.owner_user_id === DEMO_USERS.danny);
  assert.equal(original.created_at, NOW);
  assert.equal(original.local_date, '2026-09-24');
  assert.deepEqual(original.motion_ids, ['danny']);
  assert.equal(original.status, 'preview');
  await db.prepare(`UPDATE sponsorship_motions SET next_action = 'Changed next action' WHERE id = 'danny'`).run();
  const live = await listReminderPreviews(db, { now: NOW });
  assert.match(live.find(item => item.owner_user_id === DEMO_USERS.danny).body_text, /Changed next action/);
  const repeat = await captureReminderPreviews(db, { now: '2026-09-24T16:45:00Z' });
  assert.equal(repeat.created_count, 0);
  assert.equal(repeat.items.find(item => item.owner_user_id === DEMO_USERS.danny).body_text, original.body_text);
  const nextDay = await captureReminderPreviews(db, { now: '2026-09-25T16:00:00Z' });
  assert.equal(nextDay.created_count, 2);
  snapshots = await listReminderDigests(db);
  assert.equal(snapshots.length, 4);
  assert.equal(snapshots[0].local_date, '2026-09-25');
});

test('completed, non-overdue, terminal, and archived tasks never create empty captures', async (t) => {
  const { db, close } = await createSponsorshipDb(); t.after(close);
  await insertMotion(db, 'done', { follow_up_completed_at: NOW });
  await insertMotion(db, 'today', { follow_up_on: '2026-09-24' });
  await insertMotion(db, 'future', { follow_up_on: '2026-09-25' });
  await insertMotion(db, 'undated', { follow_up_on: null });
  await insertMotion(db, 'lost', { status: 'lost' });
  await insertMotion(db, 'paid', { status: 'paid' });
  await insertMotion(db, 'archived', { campaign_id: 'campaign_old' });
  await db.prepare(`UPDATE sponsorship_campaigns SET archived_at = ? WHERE id = 'campaign_old'`).bind(NOW).run();
  const result = await captureReminderPreviews(db, { now: NOW });
  assert.deepEqual(result, { items: [], created_count: 0 });
  assert.deepEqual(await listReminderDigests(db), []);
});

test('a failed insert leaves no digest and a retry captures it once', async (t) => {
  const { db, sqlite, close } = await createSponsorshipDb(); t.after(close);
  await insertMotion(db, 'danny');
  sqlite.exec(`CREATE TRIGGER fail_digest BEFORE INSERT ON sponsorship_reminder_digests
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  await assert.rejects(captureReminderPreviews(db, { now: NOW }), /simulated write failure/);
  assert.deepEqual(await listReminderDigests(db), []);
  sqlite.exec('DROP TRIGGER fail_digest');
  assert.equal((await captureReminderPreviews(db, { now: NOW })).created_count, 1);
  assert.equal((await captureReminderPreviews(db, { now: NOW })).created_count, 0);
});

test('scheduled preview capture stays at 9am Pacific across both daylight saving transitions', async (t) => {
  const { db, close } = await createSponsorshipDb(); t.after(close);
  await insertMotion(db, 'danny', { follow_up_on: '2026-01-01' });
  const env = { SPONSORSHIP_REMINDERS_MODE: 'preview', SITE_BASE_URL: ORIGIN };
  for (const timestamp of ['2026-01-24T17:00:00Z', '2026-03-08T16:00:00Z', '2026-09-24T16:00:00Z', '2026-11-01T17:00:00Z']) {
    const result = await runScheduledSponsorshipReminders(db, { env, scheduledTime: Date.parse(timestamp) });
    assert.equal(result.created_count, 1, timestamp);
    assert.match(result.items[0].body_text, /http:\/\/localhost:8788\/admin-sponsorships/);
    const retry = await runScheduledSponsorshipReminders(db, { env, scheduledTime: Date.parse(timestamp) + 45 * 60_000 });
    assert.equal(retry.created_count, 0, timestamp);
  }
  assert.equal((await listReminderDigests(db)).length, 4);
});
