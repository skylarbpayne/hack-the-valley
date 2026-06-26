// BlogPost domain object: the one home for "a published blog post."
//
// All the incidental complexity of how a post is stored lives in here and is
// hidden behind behavior. Today a post is a static HTML page whose body is
// delimited by HTML-comment markers and listed in posts.json — but callers
// never see that. They load a BlogPost and ask it for its body / email, so the
// storage format can be swapped later (frontmatter, a CMS, a database) by
// changing only this file.

import { absolutizeUrls, buildBroadcastEmailHtml } from '../../_shared/blog-broadcast.js';

// Implementation detail: where a post's body starts/ends. PRIVATE on purpose —
// nothing outside this module should know posts use comment markers.
const POST_START = '<!-- POST:START -->';
const POST_END = '<!-- POST:END -->';

function httpError(message, status, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

export class BlogPost {
  #rawHtml;

  constructor({ slug, title = null, excerpt = null, date = null, rawHtml = '' } = {}) {
    this.slug = String(slug || '').trim();
    this.title = title;
    this.excerpt = excerpt;
    this.date = date;
    this.#rawHtml = String(rawHtml || '');
  }

  // The article body, with the marker mechanism hidden. Swap the storage format
  // later and only this method changes.
  body() {
    const start = this.#rawHtml.indexOf(POST_START);
    const end = this.#rawHtml.indexOf(POST_END);
    if (start === -1 || end === -1 || end < start) {
      throw httpError('Post is missing its <!-- POST:START -->/<!-- POST:END --> markers.', 422);
    }
    const content = this.#rawHtml.slice(start + POST_START.length, end).trim();
    if (!content) {
      throw httpError('Post content between the markers is empty.', 422);
    }
    return content;
  }

  // Public web URL of the post.
  webUrl(baseUrl) {
    return `${String(baseUrl || '').replace(/\/+$/, '')}/blog/${encodeURIComponent(this.slug)}`;
  }

  // Subject line for an email blast of this post (caller may override).
  subjectLine(override) {
    return String(override || this.title || 'Hack the Valley update').trim().slice(0, 200);
  }

  // Resend broadcast name (internal label, not shown to recipients).
  broadcastName() {
    return `Blog: ${this.title || this.slug}`;
  }

  // Render this post as the HTML of an email blast. The body extraction and the
  // root-relative→absolute URL rewrite are encapsulated here; callers just ask
  // the post to render itself.
  toEmailHtml({ baseUrl } = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    return buildBroadcastEmailHtml({
      title: this.title || this.subjectLine(),
      contentHtml: absolutizeUrls(this.body(), base),
      postUrl: this.webUrl(base),
      eventsUrl: `${base}/events`,
    });
  }
}

// Repository: load a published post from the static-asset store and return a
// BlogPost. This is the only place that knows posts live as posts.json + pages;
// it injects the assets binding so it stays testable.
export async function loadBlogPost(assets, slug, { origin } = {}) {
  const normalizedSlug = String(slug || '').trim();
  if (!normalizedSlug) throw httpError('A post slug is required.', 400);
  if (!assets?.fetch) throw httpError('Static assets binding is unavailable.', 500);

  const manifestResponse = await assetFetch(assets, origin, '/blog/posts.json');
  if (!manifestResponse || !manifestResponse.ok) {
    throw httpError('Could not load the blog manifest (posts.json).', 502);
  }
  let manifest;
  try {
    manifest = await manifestResponse.json();
  } catch {
    throw httpError('Blog manifest is invalid (posts.json could not be parsed).', 422);
  }
  if (!manifest || !Array.isArray(manifest.posts)) {
    throw httpError('Blog manifest is invalid (missing a "posts" array).', 422);
  }
  const entry = manifest.posts.find((post) => post && post.slug === normalizedSlug);
  if (!entry) {
    throw httpError(`No published post with slug "${normalizedSlug}".`, 404);
  }

  const pageResponse = await assetFetch(assets, origin, `/blog/${encodeURIComponent(normalizedSlug)}`);
  if (!pageResponse || !pageResponse.ok) {
    throw httpError(`Could not load the post page for "${normalizedSlug}".`, 404);
  }
  const rawHtml = await pageResponse.text();

  return new BlogPost({
    slug: normalizedSlug,
    title: entry.title,
    excerpt: entry.excerpt,
    date: entry.date,
    rawHtml,
  });
}

function assetFetch(assets, origin, path) {
  const url = new URL(path, origin).toString();
  return assets.fetch(new Request(url, { headers: { Accept: '*/*' } }));
}
