import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SUBMISSION_TRACKS,
  corsHeaders,
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

test('public surfaces use extensionless canonical submit path', () => {
  const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const adminHtml = readFileSync(new URL('../public/admin-submissions.html', import.meta.url), 'utf8');
  assert.match(indexHtml, /href="\/submit"/);
  assert.match(adminHtml, /href="\/submit"/);
  assert.doesNotMatch(indexHtml, /href="\/submit\.html"/);
  assert.doesNotMatch(adminHtml, /href="\/submit\.html"/);
});

test('custom-domain scripts send APIs to the Worker API origin', () => {
  const submitJs = readFileSync(new URL('../public/submissions.js', import.meta.url), 'utf8');
  const adminJs = readFileSync(new URL('../public/admin-submissions.js', import.meta.url), 'utf8');
  for (const js of [submitJs, adminJs]) {
    assert.match(js, /API_ORIGIN\s*=\s*'https:\/\/hack-the-valley\.pages\.dev'/);
  }
  assert.match(submitJs, /apiUrl\(`\/api\/upload/);
  assert.match(submitJs, /apiUrl\('\/api\/submissions'\)/);
  assert.match(adminJs, /apiUrl\('\/api\/submissions'\)/);
  assert.match(adminJs, /apiUrl\(`\/api\/media/);
  assert.doesNotMatch(submitJs, /xhr\.open\('POST', `\/api\/upload/);
  assert.doesNotMatch(submitJs, /fetch\('\/api\/submissions'/);
  assert.doesNotMatch(adminJs, /fetch\('\/api\/submissions'/);
});

test('admin page renders uploaded images and videos inline with download links', () => {
  const adminJs = readFileSync(new URL('../public/admin-submissions.js', import.meta.url), 'utf8');
  assert.match(adminJs, /function renderUpload\(upload\)/);
  assert.match(adminJs, /<img[\s\S]+src="\$\{url\}"[\s\S]+loading="lazy"/);
  assert.match(adminJs, /<video[\s\S]+controls[\s\S]+src="\$\{url\}"/);
  assert.match(adminJs, /Open\/download/);
});

test('CORS headers allow the custom domain to call Worker APIs', () => {
  const headers = corsHeaders();
  assert.equal(headers['access-control-allow-origin'], '*');
  assert.match(headers['access-control-allow-methods'], /POST/);
  assert.match(headers['access-control-allow-methods'], /OPTIONS/);
  assert.match(headers['access-control-allow-headers'], /content-type/);
});

test('csvEscape safely quotes commas, quotes, and newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('hello, "world"\n'), '"hello, ""world""\n"');
  assert.equal(csvEscape(null), '');
});

test('isAuthorized accepts bearer, x-admin-token, token query param, and shared HTV admin token', () => {
  const env = { SUBMISSIONS_ADMIN_TOKEN: 'secret' };
  assert.equal(isAuthorized(new Request('https://example.com/admin', { headers: { authorization: 'Bearer secret' } }), env), true);
  assert.equal(isAuthorized(new Request('https://example.com/admin', { headers: { 'x-admin-token': 'secret' } }), env), true);
  assert.equal(isAuthorized(new Request('https://example.com/admin?token=secret'), env), true);
  assert.equal(isAuthorized(new Request('https://example.com/admin?token=nope'), env), false);
  assert.equal(isAuthorized(new Request('https://example.com/admin', { headers: { 'x-admin-token': 'shared' } }), { HTV_ADMIN_TOKEN: 'shared' }), true);
  assert.equal(isAuthorized(new Request('https://example.com/admin'), {}), false);
});

test('submissions app-db migration helper avoids SQL transaction-control statements', () => {
  const script = readFileSync(new URL('../scripts/migrate-submissions-to-app-db.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /BEGIN\s+TRANSACTION/i);
  assert.doesNotMatch(script, /SAVEPOINT/i);
  assert.doesNotMatch(script, /COMMIT\s*;/i);
});

test('project migration helper is dry-run first, backs up source rows, and writes idempotent project links', () => {
  const script = readFileSync(new URL('../scripts/migrate-projects-from-submissions.sh', import.meta.url), 'utf8');
  assert.match(script, /APPLY=0/);
  assert.match(script, /backup-submissions/);
  assert.match(script, /INSERT OR IGNORE INTO events/);
  assert.match(script, /INSERT INTO projects/);
  assert.match(script, /ON CONFLICT\(slug\) DO UPDATE SET/);
  assert.match(script, /INSERT INTO project_members/);
  assert.match(script, /ON CONFLICT\(project_id, email\) DO UPDATE SET/);
  assert.match(script, /INSERT INTO event_project_submissions/);
  assert.match(script, /ON CONFLICT\(id\) DO UPDATE SET status=excluded\.status/);
  assert.match(script, /Dry run complete\. No target data was changed\./);
  assert.doesNotMatch(script, /DELETE FROM|DROP TABLE|TRUNCATE/i);
});

test('jsonResponse returns JSON with no-store cache headers', async () => {
  const response = jsonResponse({ ok: true }, { status: 201 });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true });
});
