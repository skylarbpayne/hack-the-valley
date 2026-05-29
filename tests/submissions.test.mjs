import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SUBMISSION_TRACKS,
  csvEscape,
  isAuthorized,
  jsonResponse,
  normalizeSubmissionTracks,
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
    tracks: ['AI'],
    description: 'A useful project for local farms.',
    uploads: [{ kind: 'video', key: 'submissions/team/demo.mp4', filename: 'demo.mp4', size: 100 }],
  });
  assert.equal(valid.ok, true);

  const invalid = validateSubmission({
    teamName: 'Missing Media',
    projectTitle: 'Nope',
    contactEmail: 'bad-email',
    members: 'One',
    tracks: [],
    description: 'No video or image upload and no media link.',
    uploads: [],
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /valid contact email/);
  assert.match(invalid.errors.join('\n'), /video upload, image upload, or media link/);
});

test('validateSubmission allows no track and accepts multiple official tracks', () => {
  assert.deepEqual(SUBMISSION_TRACKS, ['Education', 'Social Impact', 'AI']);
  assert.deepEqual(normalizeSubmissionTracks(['Education', 'AI', 'AI', '']), ['Education', 'AI']);
  assert.deepEqual(normalizeSubmissionTracks('Social Impact | AI'), ['Social Impact', 'AI']);

  const noTrack = validateSubmission({
    teamName: 'No Track Team',
    projectTitle: 'Useful Thing',
    contactEmail: 'student@example.edu',
    members: 'Ada, Grace',
    description: 'A useful project for the community.',
    mediaLink: 'https://example.com/demo',
    tracks: [],
  });
  assert.equal(noTrack.ok, true);

  const multiTrack = validateSubmission({
    teamName: 'Multi Track Team',
    projectTitle: 'AI Classroom Helper',
    contactEmail: 'student@example.edu',
    members: 'Ada, Grace',
    description: 'A useful project for teachers.',
    mediaLink: 'https://example.com/demo',
    tracks: ['Education', 'AI'],
  });
  assert.equal(multiTrack.ok, true);
});

test('participant form exposes optional checkbox tracks only for Education, Social Impact, and AI', () => {
  const html = readFileSync(new URL('../public/submit.html', import.meta.url), 'utf8');
  assert.match(html, /Track\(s\)/);
  assert.doesNotMatch(html, /id="track"[^>]*required/);
  assert.doesNotMatch(html, /<select[^>]*id="track"/);
  for (const track of SUBMISSION_TRACKS) {
    assert.match(html, new RegExp(`name="tracks"[^>]+value="${track}"`));
  }
  for (const staleTrack of ['AI for Good', 'Health', 'FinTech', 'Open Track']) {
    assert.doesNotMatch(html, new RegExp(staleTrack));
  }
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
