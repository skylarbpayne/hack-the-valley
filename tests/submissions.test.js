import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onRequestPost as submitProject } from '../functions/api/submissions.js';
import { onRequestGet as exportCsv } from '../functions/api/admin/export.js';

function makeFakeEnv() {
  const puts = [];
  const rows = [];
  const env = {
    ADMIN_TOKEN: 'test-admin-token',
    SUBMISSIONS_BUCKET: {
      async put(key, body, options) {
        const size = body?.size ?? body?.byteLength ?? 0;
        puts.push({ key, size, httpMetadata: options?.httpMetadata ?? {} });
        return { key };
      },
      async get(key) {
        const object = puts.find((item) => item.key === key);
        if (!object) return null;
        return {
          body: new Blob(['stored object']).stream(),
          httpMetadata: object.httpMetadata,
          writeHttpMetadata(headers) {
            if (object.httpMetadata.contentType) headers.set('Content-Type', object.httpMetadata.contentType);
          }
        };
      }
    },
    SUBMISSIONS_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              async run() {
                if (/insert into submissions/i.test(sql)) {
                  rows.push({
                    id: params[0],
                    submitted_at: params[1],
                    team_name: params[2],
                    contact_name: params[3],
                    contact_email: params[4],
                    project_title: params[5],
                    track: params[6],
                    description: params[7],
                    demo_url: params[8],
                    repo_url: params[9],
                    slides_url: params[10],
                    members: params[11],
                    media_json: params[12],
                    status: params[13]
                  });
                }
                return { success: true };
              },
              async all() {
                return { results: [...rows] };
              },
              async first() {
                return rows.find((row) => row.id === params[0]) ?? null;
              }
            };
          },
          async all() {
            return { results: [...rows] };
          }
        };
      }
    },
    __rows: rows,
    __puts: puts
  };
  return env;
}

function submissionForm(overrides = {}) {
  const form = new FormData();
  const values = {
    teamName: 'Team Valley',
    contactName: 'Ada Lovelace',
    contactEmail: 'ada@example.com',
    members: 'Ada Lovelace, Grace Hopper',
    projectTitle: 'Farm Signal',
    track: 'ai',
    description: 'An AI assistant for small farms in the Central Valley.',
    demoUrl: 'https://example.com/demo',
    repoUrl: 'https://github.com/example/farm-signal',
    slidesUrl: '',
    ...overrides
  };

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) form.set(key, value);
  }
  form.set('images', new File(['fake image'], 'screenshot.png', { type: 'image/png' }));
  form.set('video', new File(['fake video'], 'demo.mp4', { type: 'video/mp4' }));
  return form;
}

test('project submission stores metadata in D1 and media objects in R2', async () => {
  const env = makeFakeEnv();
  const request = new Request('https://hackthevalley.test/api/submissions', {
    method: 'POST',
    body: submissionForm()
  });

  const response = await submitProject({ request, env });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.match(payload.submissionId, /^htv_[a-z0-9]+_[a-z0-9]+$/);
  assert.equal(env.__rows.length, 1);
  assert.equal(env.__rows[0].team_name, 'Team Valley');
  assert.equal(env.__rows[0].contact_email, 'ada@example.com');
  assert.equal(env.__rows[0].status, 'submitted');
  assert.equal(env.__puts.length, 2);
  assert.ok(env.__puts.every((item) => item.key.startsWith(`${payload.submissionId}/`)));
  assert.ok(JSON.parse(env.__rows[0].media_json).some((item) => item.kind === 'video'));
});

test('project submission rejects missing required fields before upload/storage', async () => {
  const env = makeFakeEnv();
  const request = new Request('https://hackthevalley.test/api/submissions', {
    method: 'POST',
    body: submissionForm({ contactEmail: '' })
  });

  const response = await submitProject({ request, env });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.success, false);
  assert.match(payload.error, /contact email/i);
  assert.equal(env.__rows.length, 0);
  assert.equal(env.__puts.length, 0);
});

test('admin csv export requires bearer token and escapes submitted data', async () => {
  const env = makeFakeEnv();
  const submitRequest = new Request('https://hackthevalley.test/api/submissions', {
    method: 'POST',
    body: submissionForm({ projectTitle: 'Sensor, "Bot"' })
  });
  await submitProject({ request: submitRequest, env });

  const denied = await exportCsv({
    request: new Request('https://hackthevalley.test/api/admin/export'),
    env
  });
  assert.equal(denied.status, 401);

  const allowed = await exportCsv({
    request: new Request('https://hackthevalley.test/api/admin/export', {
      headers: { Authorization: 'Bearer test-admin-token' }
    }),
    env
  });
  const csv = await allowed.text();

  assert.equal(allowed.status, 200);
  assert.match(allowed.headers.get('Content-Disposition'), /submissions\.csv/);
  assert.match(csv.split('\n')[0], /submission_id,submitted_at,team_name/);
  assert.match(csv, /"Sensor, ""Bot"""/);
});
