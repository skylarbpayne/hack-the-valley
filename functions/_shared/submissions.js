export const SUBMISSION_TRACKS = ['Education', 'Social Impact', 'AI'];

const REQUIRED_FIELDS = [
  ['teamName', 'team name'],
  ['projectTitle', 'project title'],
  ['contactEmail', 'valid contact email'],
  ['members', 'team members'],
  ['description', 'short project description'],
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-admin-token, x-filename, x-project-title, x-team-name, x-upload-kind',
    'access-control-max-age': '86400',
  };
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function jsonResponse(body, init = {}) {
  const headers = new Headers({ ...corsHeaders(), ...(init.headers || {}) });
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(message, status = 400, extra = {}) {
  return jsonResponse({ ok: false, error: message, ...extra }, { status });
}

export function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'submission';
}

export function sanitizeFilename(value) {
  const raw = String(value || '').split(/[\\/]/).pop() || '';
  const normalized = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const match = normalized.match(/^(.*?)(\.[a-zA-Z0-9]{1,12})?$/);
  const base = (match?.[1] || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
  const ext = match?.[2] || '';
  const cleaned = `${base || 'upload'}${ext}`.slice(0, 120);
  return cleaned || 'upload';
}

export function randomId(prefix = 'sub') {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${id}`;
}

export function maxUploadBytes(env = {}) {
  const configured = Number(env.MAX_UPLOAD_BYTES || env.MAX_UPLOAD_MB && Number(env.MAX_UPLOAD_MB) * 1024 * 1024);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

export function validateUploadRequest({ filename, kind, contentType, contentLength, env = {} }) {
  const errors = [];
  const safeFilename = sanitizeFilename(filename);
  const normalizedKind = String(kind || '').toLowerCase();
  const allowedKinds = new Set(['video', 'image', 'artifact', 'other']);
  if (!allowedKinds.has(normalizedKind)) errors.push('Upload kind must be video, image, artifact, or other.');

  const type = String(contentType || '').toLowerCase();
  const isAllowedType =
    type.startsWith('video/') ||
    type.startsWith('image/') ||
    type === 'application/pdf' ||
    type === 'application/zip' ||
    type === 'application/x-zip-compressed' ||
    type === 'application/octet-stream';
  if (!isAllowedType) errors.push('Unsupported file type. Upload video, image, PDF, ZIP, or paste a link instead.');

  const size = Number(contentLength || 0);
  const limit = maxUploadBytes(env);
  if (size && size > limit) {
    errors.push(`File is too large. Limit is ${Math.round(limit / 1024 / 1024)}MB; paste a YouTube/Loom/Drive link for larger videos.`);
  }

  return { ok: errors.length === 0, errors, safeFilename, normalizedKind, contentType: type || 'application/octet-stream', size };
}

export function buildObjectKey({ teamName, projectTitle, filename, kind }) {
  const teamSlug = slugify(teamName || projectTitle || 'submission');
  const safeFilename = sanitizeFilename(filename);
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  return `submissions/${teamSlug}/${kind || 'file'}-${now}-${randomId('file')}-${safeFilename}`;
}

export function normalizeSubmissionTracks(value) {
  const rawTracks = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[|,]/);
  const allowed = new Set(SUBMISSION_TRACKS);
  const seen = new Set();
  const tracks = [];
  for (const rawTrack of rawTracks) {
    const track = String(rawTrack || '').trim();
    if (!track || !allowed.has(track) || seen.has(track)) continue;
    seen.add(track);
    tracks.push(track);
  }
  return tracks;
}

export function trackLabel(payload = {}) {
  return normalizeSubmissionTracks(payload.tracks ?? payload.track).join(' | ');
}

export function validateSubmission(payload = {}) {
  const errors = [];
  const get = (key) => String(payload[key] || '').trim();

  for (const [key, label] of REQUIRED_FIELDS) {
    if (!get(key)) errors.push(`Missing ${label}.`);
  }

  if (get('contactEmail') && !EMAIL_RE.test(get('contactEmail'))) {
    errors.push('Provide a valid contact email.');
  }

  const uploads = Array.isArray(payload.uploads) ? payload.uploads : [];
  const validUploads = uploads.filter((upload) => upload && upload.key && upload.filename);
  const mediaLink = get('mediaLink');
  const demoLink = get('demoLink');
  const hasVideo = validUploads.some((upload) => String(upload.kind || '').toLowerCase() === 'video');
  const hasImage = validUploads.some((upload) => String(upload.kind || '').toLowerCase() === 'image');

  if (!hasVideo && !hasImage && !mediaLink && !demoLink) {
    errors.push('Add at least one video upload, image upload, or media link.');
  }

  return { ok: errors.length === 0, errors, uploads: validUploads };
}

export function isAuthorized(request, env = {}) {
  const expected = env.SUBMISSIONS_ADMIN_TOKEN;
  if (!expected) return false;
  const url = new URL(request.url);
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const headerToken = request.headers.get('x-admin-token');
  const queryToken = url.searchParams.get('token');
  return [bearer, headerToken, queryToken].some((token) => token === expected);
}

export async function ensureTables(env = {}) {
  if (!env.SUBMISSIONS_DB) throw new Error('Missing SUBMISSIONS_DB D1 binding');
  await env.SUBMISSIONS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      team_name TEXT NOT NULL,
      project_title TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      track TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      uploads_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted'
    )
  `).run();
}

export async function insertSubmission(env, payload, uploads) {
  await ensureTables(env);
  const id = randomId('htv');
  const createdAt = new Date().toISOString();
  await env.SUBMISSIONS_DB.prepare(`
    INSERT INTO submissions (
      id, created_at, team_name, project_title, contact_email, track,
      payload_json, uploads_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    createdAt,
    String(payload.teamName || '').trim(),
    String(payload.projectTitle || '').trim(),
    String(payload.contactEmail || '').trim().toLowerCase(),
    trackLabel(payload),
    JSON.stringify({ ...payload, tracks: normalizeSubmissionTracks(payload.tracks ?? payload.track), track: trackLabel(payload) }),
    JSON.stringify(uploads),
    'submitted'
  ).run();
  return { id, createdAt };
}

export async function listSubmissions(env) {
  await ensureTables(env);
  const result = await env.SUBMISSIONS_DB.prepare(`
    SELECT id, created_at, team_name, project_title, contact_email, track, payload_json, uploads_json, status
    FROM submissions
    ORDER BY created_at DESC
  `).all();

  return (result.results || []).map((row) => {
    const payload = safeJson(row.payload_json, {});
    const tracks = normalizeSubmissionTracks(payload.tracks ?? row.track);
    return {
      id: row.id,
      createdAt: row.created_at,
      teamName: row.team_name,
      projectTitle: row.project_title,
      contactEmail: row.contact_email,
      track: tracks.length ? tracks.join(' | ') : String(row.track || '').trim(),
      tracks,
      status: row.status,
      payload,
      uploads: safeJson(row.uploads_json, []),
    };
  });
}

export function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function submissionsToCsv(submissions) {
  const headers = [
    'id', 'created_at', 'team_name', 'project_title', 'contact_email', 'members', 'track',
    'description', 'repo_link', 'demo_link', 'media_link', 'uploads', 'status'
  ];
  const rows = submissions.map((submission) => {
    const payload = submission.payload || {};
    const uploadSummary = (submission.uploads || [])
      .map((upload) => `${upload.kind || 'file'}:${upload.filename || upload.key}`)
      .join(' | ');
    return [
      submission.id,
      submission.createdAt,
      submission.teamName,
      submission.projectTitle,
      submission.contactEmail,
      payload.members,
      submission.track,
      payload.description,
      payload.repoLink,
      payload.demoLink,
      payload.mediaLink,
      uploadSummary,
      submission.status,
    ].map(csvEscape).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}
