import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const submit = readFileSync(new URL('../public/submit.html', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../public/admin-submissions.html', import.meta.url), 'utf8');

const requiredSubmitSnippets = [
  '<form id="submission-form"',
  'name="teamName"',
  'name="contactEmail"',
  'name="projectTitle"',
  'name="track"',
  'name="description"',
  'name="images"',
  'name="video"',
  '/api/submissions',
  'validateMediaFiles'
];

for (const snippet of requiredSubmitSnippets) {
  assert.ok(submit.includes(snippet), `submit.html missing ${snippet}`);
}

const requiredAdminSnippets = [
  '/api/admin/submissions',
  '/api/admin/export',
  'admin-token',
  'CSV Export',
  'media-link'
];

for (const snippet of requiredAdminSnippets) {
  assert.ok(admin.includes(snippet), `admin-submissions.html missing ${snippet}`);
}

console.log('Submission pages include required form/admin hooks.');
