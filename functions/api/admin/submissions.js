import { json, parseMedia, requireAdmin } from '../../_shared/admin.js';

function publicSubmission(row) {
  const media = parseMedia(row).map((item) => ({
    ...item,
    adminUrl: `/api/admin/media?key=${encodeURIComponent(item.key)}`
  }));
  return {
    id: row.id,
    submittedAt: row.submitted_at,
    teamName: row.team_name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    projectTitle: row.project_title,
    track: row.track,
    description: row.description,
    demoUrl: row.demo_url,
    repoUrl: row.repo_url,
    slidesUrl: row.slides_url,
    members: row.members,
    status: row.status,
    media
  };
}

export async function onRequestGet({ request, env }) {
  const admin = requireAdmin(request, env);
  if (!admin.ok) return admin.response;

  if (!env?.SUBMISSIONS_DB) {
    return json({ success: false, error: 'Submission database is not configured' }, 500);
  }

  const { results } = await env.SUBMISSIONS_DB
    .prepare('SELECT * FROM submissions ORDER BY submitted_at DESC')
    .all();

  return json({ success: true, submissions: (results || []).map(publicSubmission) });
}
