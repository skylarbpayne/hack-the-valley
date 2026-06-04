import {
  errorResponse,
  jsonResponse,
  optionsResponse,
} from '../_shared/submissions.js';
import {
  syncContactWithResend,
  validateSubscribePayload,
} from '../_shared/mailing-list.js';

export function onRequestOptions() {
  return optionsResponse();
}

async function parsePayload(request) {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return request.json();
  }
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  return request.json();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const fetcher = context.fetch || fetch;

  let payload;
  try {
    payload = await parsePayload(request);
  } catch {
    return errorResponse('Invalid signup payload.', 400);
  }

  const validation = validateSubscribePayload(payload);
  if (!validation.ok) {
    return errorResponse('Could not join the updates list.', 400, { errors: validation.errors });
  }

  try {
    await syncContactWithResend({ subscriber: validation.subscriber, env, fetcher });
    return jsonResponse({
      ok: true,
      message: 'You are on the Hack the Valley updates list.',
    });
  } catch (error) {
    if (error?.status === 503) {
      return errorResponse('Mailing list is not configured yet. Email contact@hackthevalley.org and we will add you manually.', 503);
    }
    console.error('subscribe_resend_failed', error?.message || error);
    return errorResponse('Could not join the updates list right now. Email contact@hackthevalley.org and we will add you manually.', 502);
  }
}
