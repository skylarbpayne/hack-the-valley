import {
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin
} from "../../../_lib/event-platform.js";
import {
  corsHeaders,
  maxUploadBytes,
  optionsResponse,
  randomId,
  sanitizeFilename
} from "../../../_shared/submissions.js";

function imageKeyFor(slug, filename) {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  return `event-images/${slug}/${now}-${randomId("img")}-${sanitizeFilename(filename || "event-image")}`;
}

function assertImageUpload(request, env) {
  const type = String(request.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith("image/")) {
    throw Object.assign(new Error("Event image must be an image file."), { status: 400 });
  }

  const size = Number(request.headers.get("content-length") || 0);
  const limit = maxUploadBytes(env);
  if (size && size > limit) {
    throw Object.assign(new Error(`Event image is too large. Limit is ${Math.round(limit / 1024 / 1024)}MB.`), { status: 400 });
  }

  return type;
}

function assertEventImageKey(slug, key) {
  const prefix = `event-images/${slug}/`;
  if (!key || !key.startsWith(prefix)) {
    throw Object.assign(new Error("Valid event image key required."), { status: 400 });
  }
}

export function onRequestOptions() {
  return optionsResponse();
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    if (!context.env.SUBMISSIONS_MEDIA) {
      throw Object.assign(new Error("Upload storage is not configured."), { status: 503 });
    }

    const slug = context.params.slug;
    const contentType = assertImageUpload(context.request, context.env);
    const url = new URL(context.request.url);
    const filename = url.searchParams.get("filename") || context.request.headers.get("x-filename") || "event-image";
    const key = imageKeyFor(slug, filename);

    await context.env.SUBMISSIONS_MEDIA.put(key, context.request.body, {
      httpMetadata: { contentType },
      customMetadata: {
        originalFilename: sanitizeFilename(filename),
        kind: "event-image",
        eventSlug: slug,
        uploadedAt: new Date().toISOString()
      }
    });

    const imageUrl = `/api/events/${encodeURIComponent(slug)}/image?key=${encodeURIComponent(key)}`;
    return jsonResponse({ ok: true, image_url: imageUrl, image_key: key });
  });
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    if (!context.env.SUBMISSIONS_MEDIA) {
      throw Object.assign(new Error("Upload storage is not configured."), { status: 503 });
    }

    const slug = context.params.slug;
    const url = new URL(context.request.url);
    const key = url.searchParams.get("key");
    assertEventImageKey(slug, key);

    const object = await context.env.SUBMISSIONS_MEDIA.get(key);
    if (!object) {
      throw Object.assign(new Error("Event image not found."), { status: 404 });
    }

    const headers = new Headers(corsHeaders());
    object.writeHttpMetadata?.(headers);
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("content-disposition", `inline; filename="${object.customMetadata?.originalFilename || "event-image"}"`);
    return new Response(object.body, { headers });
  });
}

export async function onRequest() {
  return methodNotAllowed(["GET", "POST"]);
}
