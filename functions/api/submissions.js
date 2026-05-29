import {
  errorResponse,
  insertSubmission,
  isAuthorized,
  jsonResponse,
  listSubmissions,
  submissionsToCsv,
  validateSubmission,
} from '../_shared/submissions.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse('Invalid JSON payload.', 400);
  }

  if (payload.website) {
    return errorResponse('Spam check failed.', 400);
  }

  const validation = validateSubmission(payload);
  if (!validation.ok) {
    return errorResponse('Submission is missing required information.', 400, { errors: validation.errors });
  }

  try {
    const saved = await insertSubmission(env, payload, validation.uploads);
    return jsonResponse({
      ok: true,
      id: saved.id,
      createdAt: saved.createdAt,
      message: 'Project submitted. Save this confirmation ID.',
    });
  } catch (error) {
    console.error('submission_insert_failed', error);
    return errorResponse('Submission storage is not configured yet. Save your project details and ask an organizer for help.', 503);
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const wantsCsv = url.searchParams.get('format') === 'csv';

  if (!isAuthorized(request, env)) {
    return errorResponse('Admin token required.', 401);
  }

  try {
    const submissions = await listSubmissions(env);
    if (wantsCsv) {
      return new Response(submissionsToCsv(submissions), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="hack-the-valley-submissions.csv"',
          'cache-control': 'no-store',
        },
      });
    }
    return jsonResponse({ ok: true, submissions });
  } catch (error) {
    console.error('submission_list_failed', error);
    return errorResponse('Submission database is not configured yet.', 503);
  }
}
