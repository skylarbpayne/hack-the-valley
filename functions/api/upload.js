import {
  buildObjectKey,
  errorResponse,
  jsonResponse,
  validateUploadRequest,
} from '../_shared/submissions.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SUBMISSIONS_MEDIA) {
    return errorResponse('Upload storage is not configured yet. Ask an organizer for the fallback media-link option.', 503);
  }

  const url = new URL(request.url);
  const filename = url.searchParams.get('filename') || request.headers.get('x-filename') || 'upload';
  const kind = url.searchParams.get('kind') || request.headers.get('x-upload-kind') || 'other';
  const teamName = url.searchParams.get('teamName') || request.headers.get('x-team-name') || 'submission';
  const projectTitle = url.searchParams.get('projectTitle') || request.headers.get('x-project-title') || '';
  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  const contentLength = request.headers.get('content-length') || '0';

  const validation = validateUploadRequest({ filename, kind, contentType, contentLength, env });
  if (!validation.ok) {
    return errorResponse('Upload rejected.', 400, { errors: validation.errors });
  }

  const key = buildObjectKey({
    teamName,
    projectTitle,
    filename: validation.safeFilename,
    kind: validation.normalizedKind,
  });

  await env.SUBMISSIONS_MEDIA.put(key, request.body, {
    httpMetadata: { contentType: validation.contentType },
    customMetadata: {
      originalFilename: validation.safeFilename,
      kind: validation.normalizedKind,
      teamName: String(teamName).slice(0, 120),
      projectTitle: String(projectTitle).slice(0, 120),
      uploadedAt: new Date().toISOString(),
    },
  });

  return jsonResponse({
    ok: true,
    upload: {
      key,
      kind: validation.normalizedKind,
      filename: validation.safeFilename,
      contentType: validation.contentType,
      size: validation.size,
    },
  });
}
