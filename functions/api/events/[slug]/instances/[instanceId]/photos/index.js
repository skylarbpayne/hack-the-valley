import {
  countEventPhotos,
  createEventPhotoRecord,
  getDb,
  getEventInstance,
  getPublishedEventPhotoByStorageKey,
  handleErrors,
  jsonResponse,
  listEventPhotos,
  methodNotAllowed,
  prepareEventPhotoUploadFromOrganizerRoute,
  requireOrganizerAccess
} from "../../../../../../_lib/event-platform.js";
import { maxUploadBytes, optionsResponse, randomId } from "../../../../../../_shared/submissions.js";

const PUBLIC_EVENT_PHOTO_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif"
]);

export function onRequestOptions() {
  return optionsResponse();
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const db = getDb(context.env);
    const url = new URL(context.request.url);
    const storageKey = url.searchParams.get("key");
    if (storageKey) {
      if (!context.env.SUBMISSIONS_MEDIA) {
        return jsonResponse({ error: "Upload storage is not configured." }, { status: 503 });
      }
      const photo = await getPublishedEventPhotoByStorageKey(
        db,
        context.params.slug,
        context.params.instanceId,
        storageKey
      );
      if (!photo) return jsonResponse({ error: "Photo not found" }, { status: 404 });
      const object = await context.env.SUBMISSIONS_MEDIA.get(photo.storage_key);
      if (!object) return jsonResponse({ error: "Photo not found" }, { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata?.(headers);
      const contentType = String(photo.content_type || headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!PUBLIC_EVENT_PHOTO_CONTENT_TYPES.has(contentType)) {
        return jsonResponse({ error: "Unsupported photo type" }, { status: 415 });
      }
      headers.set("content-type", contentType);
      headers.set("x-content-type-options", "nosniff");
      if (object.httpEtag) headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=3600");
      return new Response(object.body, { headers });
    }

    await requireOrganizerAccess(context.request, context.env);
    const instance = await getEventInstance(db, context.params.slug, context.params.instanceId);
    if (!instance) return jsonResponse({ error: "Event instance not found" }, { status: 404 });
    const [photos, count] = await Promise.all([
      listEventPhotos(db, context.params.slug, context.params.instanceId),
      countEventPhotos(db, context.params.slug, context.params.instanceId)
    ]);
    return jsonResponse({ photos, count });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    if (!context.env.SUBMISSIONS_MEDIA) {
      return jsonResponse({ error: "Upload storage is not configured." }, { status: 503 });
    }
    const db = getDb(context.env);
    const instance = await getEventInstance(db, context.params.slug, context.params.instanceId);
    if (!instance) return jsonResponse({ error: "Event instance not found" }, { status: 404 });

    const url = new URL(context.request.url);
    const upload = prepareEventPhotoUploadFromOrganizerRoute({
      slug: context.params.slug,
      eventInstanceId: context.params.instanceId,
      filename: url.searchParams.get("filename") || context.request.headers.get("x-filename") || "event-photo",
      kind: url.searchParams.get("kind") || context.request.headers.get("x-upload-kind") || "photo",
      contentType: context.request.headers.get("content-type") || "",
      contentLength: context.request.headers.get("content-length") || "0",
      maxBytes: maxUploadBytes(context.env),
      id: randomId("pho")
    });
    if (!upload.ok) {
      return jsonResponse({ error: upload.error, errors: upload.errors }, { status: 400 });
    }

    const body = await context.request.arrayBuffer();
    const actualSize = body.byteLength;
    const limit = maxUploadBytes(context.env);
    if (actualSize > limit) {
      return jsonResponse({
        error: "Upload rejected.",
        errors: [`File is too large. Limit is ${Math.round(limit / 1024 / 1024)}MB.`]
      }, { status: 400 });
    }
    await context.env.SUBMISSIONS_MEDIA.put(upload.key, body, {
      httpMetadata: { contentType: upload.contentType },
      customMetadata: upload.metadata
    });
    const photo = await createEventPhotoRecord(db, {
      id: upload.id,
      eventSlug: context.params.slug,
      eventInstanceId: context.params.instanceId,
      kind: upload.kind,
      storageKey: upload.key,
      publicUrl: upload.publicUrl,
      originalFilename: upload.safeFilename,
      contentType: upload.contentType,
      bytes: actualSize
    });
    return jsonResponse({ ok: true, photo }, { status: 201 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
