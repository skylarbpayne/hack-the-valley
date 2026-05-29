import { corsHeaders, errorResponse, isAuthorized, optionsResponse } from '../_shared/submissions.js';

export function onRequestOptions() {
  return optionsResponse();
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!isAuthorized(request, env)) {
    return errorResponse('Admin token required.', 401);
  }
  if (!key || !key.startsWith('submissions/')) {
    return errorResponse('Valid media key required.', 400);
  }
  if (!env.SUBMISSIONS_MEDIA) {
    return errorResponse('Upload storage is not configured yet.', 503);
  }

  const object = await env.SUBMISSIONS_MEDIA.get(key);
  if (!object) {
    return errorResponse('Media file not found.', 404);
  }

  const headers = new Headers(corsHeaders());
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, no-store');
  headers.set('content-disposition', `inline; filename="${object.customMetadata?.originalFilename || 'submission-media'}"`);
  return new Response(object.body, { headers });
}
