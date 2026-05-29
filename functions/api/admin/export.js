import { csvCell, parseMedia, requireAdmin } from '../../_shared/admin.js';

const COLUMNS = [
  ['submission_id', (row) => row.id],
  ['submitted_at', (row) => row.submitted_at],
  ['team_name', (row) => row.team_name],
  ['contact_name', (row) => row.contact_name],
  ['contact_email', (row) => row.contact_email],
  ['project_title', (row) => row.project_title],
  ['track', (row) => row.track],
  ['description', (row) => row.description],
  ['demo_url', (row) => row.demo_url],
  ['repo_url', (row) => row.repo_url],
  ['slides_url', (row) => row.slides_url],
  ['members', (row) => row.members],
  ['status', (row) => row.status],
  ['media_files', (row) => parseMedia(row).map((item) => item.key).join(' | ')]
];

export async function onRequestGet({ request, env }) {
  const admin = requireAdmin(request, env);
  if (!admin.ok) return admin.response;

  if (!env?.SUBMISSIONS_DB) {
    return new Response('Submission database is not configured', { status: 500 });
  }

  const { results } = await env.SUBMISSIONS_DB
    .prepare('SELECT * FROM submissions ORDER BY submitted_at DESC')
    .all();

  const header = COLUMNS.map(([name]) => name).join(',');
  const rows = (results || []).map((row) => COLUMNS.map(([, getter]) => csvCell(getter(row))).join(','));
  const csv = [header, ...rows].join('\n');

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="hack-the-valley-submissions.csv"'
    }
  });
}
