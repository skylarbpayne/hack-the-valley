import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, createMutationKeyStore, createSaveSession, reviewLatestDraft, filterMotions, telephoneHref } from '../public/admin-sponsorships.js';

test('contact call links preserve international prefixes and separate extensions from the number', () => {
  assert.equal(telephoneHref('(661) 555-0100'), 'tel:6615550100');
  assert.equal(telephoneHref('+1 (661) 555-0100 ext. 42'), 'tel:+16615550100;ext=42');
  assert.equal(telephoneHref('555-0102 x7'), 'tel:5550102;ext=7');
  assert.equal(telephoneHref('+44 20 7946 0958'), 'tel:+442079460958');
  for (const value of [null, '', '  ', 'Not provided', 'javascript:alert(1)', '555-0100" onclick="alert(1)']) {
    assert.equal(telephoneHref(value), null);
  }
});

test('sponsorship form converts exact dollars to cents and rejects ambiguous input', () => {
  assert.equal(parseMoney('12.30'), 1230);
  assert.equal(parseMoney('0.01'), 1);
  assert.equal(parseMoney(''), null);
  for (const value of ['-1', '1.001', '1e3', '1,000', 'Infinity']) {
    assert.throws(() => parseMoney(value), /amount/i);
  }
});

test('a failed save retains its identity, edited payloads get new keys, success starts a new action', () => {
  let counter = 0;
  const store = createMutationKeyStore(() => `action-${++counter}`);
  const first = store.key('PATCH', '/motions/one', '{"notes":"called"}');
  assert.equal(store.key('PATCH', '/motions/one', '{"notes":"called"}'), first);
  assert.notEqual(store.key('PATCH', '/motions/one', '{"notes":"emailed"}'), first);
  store.complete('PATCH', '/motions/one', '{"notes":"called"}');
  assert.notEqual(store.key('PATCH', '/motions/one', '{"notes":"called"}'), first);
});

test('review filters combine campaign, owner, status, and server-defined overdue without recomputing dates', () => {
  const rows = [
    { id: 'a', campaign_id: '2027', owner_user_id: 'u', status: 'followup', overdue: true, business_name: 'Acme' },
    { id: 'b', campaign_id: '2027', owner_user_id: 'v', status: 'followup', overdue: true, business_name: 'Other' },
    { id: 'c', campaign_id: '2026', owner_user_id: 'u', status: 'followup', overdue: false, business_name: 'Acme' },
  ];
  assert.deepEqual(filterMotions(rows, { campaign: '2027', owner: 'u', status: 'followup', overdue: true }).map(row => row.id), ['a']);
  assert.deepEqual(filterMotions(rows, { search: 'ACME' }).map(row => row.id), ['a', 'c']);
});

test('successful create followed by failed UI refresh retries the transition without creating another record', async () => {
  for (const path of ['/contacts', '/campaigns', '/motions/one/activities']) {
    let counter = 0;
    const session = createSaveSession(() => `request-${++counter}`);
    const sent = [];
    const send = async key => { sent.push(key); return { item: { id: `record-${sent.length}` } }; };
    const save = async shouldFailRefresh => session.run(async attempt => {
      const result = await attempt.mutate('POST', path, '{"name":"same draft"}', send);
      if (shouldFailRefresh) throw new Error('refresh failed after POST succeeded');
      return result;
    });
    await assert.rejects(save(true), /refresh failed/);
    assert.deepEqual(await save(false), { item: { id: 'record-1' } });
    assert.deepEqual(sent, ['request-1']);
    // A completed UI transition makes an identical new activity a new intention.
    assert.deepEqual(await save(false), { item: { id: 'record-2' } });
    assert.deepEqual(sent, ['request-1', 'request-2']);
  }
});

test('uncertain network outcomes retain the request key until the UI transition completes', async () => {
  const session = createSaveSession(() => 'stable-key');
  const sent = [];
  const run = shouldFail => session.run(attempt => attempt.mutate('PATCH', '/contacts/a', '{"revision":1}', async key => {
    sent.push(key);
    if (shouldFail) throw new Error('connection closed');
    return { item: { id: 'a', revision: 2 } };
  }));
  await assert.rejects(run(true), /connection closed/);
  await run(false);
  assert.deepEqual(sent, ['stable-key', 'stable-key']);
});

test('reviewing a conflict keeps the draft and advances the revision only on explicit acceptance', () => {
  const record = { id: 'a', revision: 1, notes: 'Original notes' };
  const draft = { notes: 'My unsaved change' };
  const latest = { id: 'a', revision: 2, notes: 'Another admin changed this' };
  const review = reviewLatestDraft(record, draft, latest);
  assert.deepEqual(review.differences, [{ field: 'notes', draft: 'My unsaved change', saved: 'Another admin changed this' }]);
  assert.equal(record.revision, 1);
  assert.equal(draft.notes, 'My unsaved change');
  review.accept();
  assert.equal(record.revision, 2);
  assert.equal(draft.notes, 'My unsaved change');
});
