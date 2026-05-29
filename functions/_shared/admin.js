export function requireAdmin(request, env) {
  const token = env?.ADMIN_TOKEN;
  if (!token) {
    return { ok: false, response: json({ success: false, error: 'Admin token is not configured' }, 500) };
  }

  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const queryToken = new URL(request.url).searchParams.get('token');
  const provided = bearer || queryToken;

  if (provided !== token) {
    return { ok: false, response: json({ success: false, error: 'Unauthorized' }, 401) };
  }

  return { ok: true };
}

export function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

export function parseMedia(row) {
  try {
    const media = JSON.parse(row.media_json || '[]');
    return Array.isArray(media) ? media : [];
  } catch {
    return [];
  }
}

export function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}
