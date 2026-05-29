import test from 'node:test';
import assert from 'node:assert/strict';

import {
  csvEscape,
  isAuthorized,
  jsonResponse,
  sanitizeFilename,
  slugify,
  validateSubmission,
} from '../functions/_shared/submissions.js';

test('slugify creates safe short ids for team names', () => {
  assert.equal(slugify('Team Rocket!! 🚀'), 'team-rocket');
  assert.equal(slugify('   '), 'submission');
  assert.equal(slugify('A'.repeat(90)).length, 64);
});

test('sanitizeFilename preserves useful extension but removes risky path parts', () => {
  assert.equal(sanitizeFilename('../demo final!.MOV'), 'demo-final.MOV');
  assert.equal(sanitizeFilename(''), 'upload');
});

test('validateSubmission requires usable project metadata and at least one media path', () => {
  const valid = validateSubmission({
    teamName: 'Central Valley Builders',
    projectTitle: 'Farm Help AI',
    contactEmail: 'student@example.edu',
    members: 'Ada, Grace',
    track: 'AI for Good',
    description: 'A useful project for local farms.',
    uploads: [{ kind: 'video', key: 'submissions/team/demo.mp4', filename: 'demo.mp4', size: 100 }],
  });
  assert.equal(valid.ok, true);

  const invalid = validateSubmission({
    teamName: 'Missing Media',
    projectTitle: 'Nope',
    contactEmail: 'bad-email',
    members: 'One',
    track: 'Open Track',
    description: 'No video or image upload and no media link.',
    uploads: [],
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /valid contact email/);
  assert.match(invalid.errors.join('\n'), /video upload, image upload, or media link/);
});

test('csvEscape safely quotes commas, quotes, and newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('hello, "world"\n'), '"hello, ""world""\n"');
  assert.equal(csvEscape(null), '');
});

test('isAuthorized accepts bearer, x-admin-token, or token query param', () => {
  const env = { SUBMISSIONS_ADMIN_TOKEN: 'secret' };
  assert.equal(isAuthorized(new Request('https://example.com/admin', { headers: { authorization: 'Bearer secret' } }), env), true);
  assert.equal(isAuthorized(new Request('https://example.com/admin', { headers: { 'x-admin-token': 'secret' } }), env), true);
  assert.equal(isAuthorized(new Request('https://example.com/admin?token=secret'), env), true);
  assert.equal(isAuthorized(new Request('https://example.com/admin?token=nope'), env), false);
  assert.equal(isAuthorized(new Request('https://example.com/admin'), {}), false);
});

test('jsonResponse returns JSON with no-store cache headers', async () => {
  const response = jsonResponse({ ok: true }, { status: 201 });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true });
});
