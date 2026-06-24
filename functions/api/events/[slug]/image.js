import {
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin
} from "../../../_lib/event-platform.js";
import {
  assertEventImageKeyForRoute,
  prepareEventImageUploadFromAdminRoute
} from "../../../_lib/domain/events.js";
import {
  corsHeaders,
  maxUploadBytes,
  optionsResponse,
  randomId,
  sanitizeFilename
} from "../../../_shared/submissions.js";

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
    const url = new URL(context.request.url);
    const filename = url.searchParams.get("filename") || context.request.headers.get("x-filename") || "event-image";
    const upload = prepareEventImageUploadFromAdminRoute({
      slug,
      filename: sanitizeFilename(filename),
      contentType: context.request.headers.get("content-type"),
      contentLength: context.request.headers.get("content-length"),
      maxBytes: maxUploadBytes(context.env),
      id: randomId("img")
    });

    await context.env.SUBMISSIONS_MEDIA.put(upload.key, context.request.body, {
      httpMetadata: { contentType: upload.contentType },
      customMetadata: upload.metadata
    });

    return jsonResponse({ ok: true, image_url: upload.imageUrl, image_key: upload.key });
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
    assertEventImageKeyForRoute(slug, key);

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
