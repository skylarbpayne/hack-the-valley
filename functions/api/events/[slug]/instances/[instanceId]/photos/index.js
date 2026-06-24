import {
  countEventPhotos,
  createEventPhotoRecord,
  getDb,
  getEventInstance,
  handleErrors,
  jsonResponse,
  listEventPhotos,
  methodNotAllowed,
  prepareEventPhotoUploadFromOrganizerRoute,
  requireOrganizerAccess
} from "../../../../../../_lib/event-platform.js";
import { maxUploadBytes, optionsResponse, randomId } from "../../../../../../_shared/submissions.js";

export function onRequestOptions() {
  return optionsResponse();
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    const db = getDb(context.env);
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
