// Pure presentation helpers for turning a published blog post into the HTML of a
// Resend email blast. These have no database, no Resend calls, and no lifecycle
// — they just transform strings. The blast lifecycle, persistence, and Resend
// orchestration live in the domain module: functions/_lib/domain/blog-broadcast.js.

const POST_START = '<!-- POST:START -->';
const POST_END = '<!-- POST:END -->';

function httpError(message, status, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

// Pull the article body out of a post page, using the markers every post carries.
export function extractPostContent(html) {
  const source = String(html || '');
  const startIdx = source.indexOf(POST_START);
  const endIdx = source.indexOf(POST_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw httpError('Post is missing its <!-- POST:START -->/<!-- POST:END --> markers.', 422);
  }
  const content = source.slice(startIdx + POST_START.length, endIdx).trim();
  if (!content) {
    throw httpError('Post content between the markers is empty.', 422);
  }
  return content;
}

// Rewrite root-relative src/href ("/images/...") to absolute URLs so they
// resolve in an email client. Leaves protocol-relative and absolute URLs alone.
export function absolutizeUrls(html, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return String(html || '');
  return String(html || '').replace(/(\s(?:src|href))="\/(?!\/)/g, `$1="${base}/`);
}

// Email clients ignore <style>/Tailwind, so any sizing the web page relied on
// is gone. Inline a width constraint on every image (otherwise full-resolution
// screenshots overflow the email width) and lightly style figure captions.
export function styleContentForEmail(html) {
  return String(html || '')
    .replace(
      /<img\b(?![^>]*\sstyle=)([^>]*)>/gi,
      '<img style="max-width:100%;height:auto;display:block;margin:16px auto;border-radius:8px;border:1px solid #e2e8f0;"$1>'
    )
    .replace(
      /<figcaption\b(?![^>]*\sstyle=)([^>]*)>/gi,
      '<figcaption style="font-size:13px;color:#64748b;text-align:center;margin-top:6px;"$1>'
    );
}

// Build an email-friendly HTML document. Email clients ignore <style>/Tailwind,
// so the chrome uses inline styles; the post body keeps its semantic tags.
export function buildBroadcastEmailHtml({ title, contentHtml, postUrl, eventsUrl } = {}) {
  const safeTitle = escapeHtml(title || 'Hack the Valley');
  const body = styleContentForEmail(contentHtml);
  const wrapperStyle = 'font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.6;';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;${wrapperStyle}">
    <div style="border-bottom:2px solid #06b6d4;padding-bottom:12px;margin-bottom:24px;">
      <span style="font-size:14px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#2563eb;">Hack the Valley</span>
    </div>
    <h1 style="font-size:26px;font-weight:800;margin:0 0 20px;color:#0f172a;">${safeTitle}</h1>
    <div style="font-size:16px;color:#334155;">
      ${body}
    </div>
    <div style="margin:32px 0;padding:24px;background:#0f172a;border-radius:12px;text-align:center;">
      <p style="margin:0 0 14px;color:#e2e8f0;font-size:16px;">Don't miss the next one.</p>
      <a href="${escapeAttr(eventsUrl || '#')}" style="display:inline-block;background:#06b6d4;color:#0f172a;font-weight:bold;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:16px;">Sign up for our next event</a>
    </div>
    <p style="font-size:13px;color:#64748b;">
      ${postUrl ? `Read this on the web: <a href="${escapeAttr(postUrl)}" style="color:#2563eb;">${escapeHtml(postUrl)}</a><br>` : ''}
      You're receiving this because you joined the Hack the Valley updates list.
      <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#64748b;">Unsubscribe</a>.
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
