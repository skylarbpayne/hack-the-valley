import { requireAdmin } from '../../_shared/admin.js';

export async function onRequestGet({ request, env }) {
  const admin = requireAdmin(request, env);
  if (!admin.ok) return admin.response;

  if (!env?.SUBMISSIONS_BUCKET) {
    return new Response('Submission bucket is not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key || !key.startsWith('htv_')) {
    return new Response('Missing or invalid media key', { status: 400 });
  }

  const object = await env.SUBMISSIONS_BUCKET.get(key);
  if (!object) {
    return new Response('Media not found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}
