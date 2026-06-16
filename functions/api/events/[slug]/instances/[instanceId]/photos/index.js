import {
  countEventPhotos,
  createEventPhotoRecord,
  getDb,
  getEventInstance,
  handleErrors,
  jsonResponse,
  listEventPhotos,
  methodNotAllowed,
  requireOrganizerAccess
} from "../../../../../../_lib/event-platform.js";
import { maxUploadBytes, optionsResponse, randomId, sanitizeFilename } from "../../../../../../_shared/submissions.js";

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

function validateEventPhotoUpload({ filename, kind, contentType, contentLength, env }) {
  const errors = [];
  const normalizedKind = String(kind || "photo").toLowerCase();
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const safeFilename = sanitizeFilename(filename || "event-photo");
  if (!["photo", "video"].includes(normalizedKind)) errors.push("kind must be photo or video");
  if (normalizedKind === "photo" && !PHOTO_TYPES.has(type)) errors.push("photo uploads must be jpeg, png, webp, heic, or heif");
  if (normalizedKind === "video" && !VIDEO_TYPES.has(type)) errors.push("video uploads must be mp4, mov, or webm");
  const size = Number(contentLength || 0);
  const limit = maxUploadBytes(env);
  if (size && size > limit) errors.push(`File is too large. Limit is ${Math.round(limit / 1024 / 1024)}MB.`);
  return { ok: errors.length === 0, errors, kind: normalizedKind, contentType: type, safeFilename, size };
}

function publicUrlFor(slug, instanceId, key) {
  return `/api/events/${encodeURIComponent(slug)}/instances/${encodeURIComponent(instanceId)}/photos?key=${encodeURIComponent(key)}`;
}

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
    const validation = validateEventPhotoUpload({
      filename: url.searchParams.get("filename") || context.request.headers.get("x-filename") || "event-photo",
      kind: url.searchParams.get("kind") || context.request.headers.get("x-upload-kind") || "photo",
      contentType: context.request.headers.get("content-type") || "",
      contentLength: context.request.headers.get("content-length") || "0",
      env: context.env
    });
    if (!validation.ok) {
      return jsonResponse({ error: "Upload rejected.", errors: validation.errors }, { status: 400 });
    }

    const id = randomId("pho");
    const key = `event-photos/${context.params.instanceId}/${id}-${validation.safeFilename}`;
    const body = await context.request.arrayBuffer();
    const actualSize = body.byteLength;
    const limit = maxUploadBytes(context.env);
    if (actualSize > limit) {
      return jsonResponse({
        error: "Upload rejected.",
        errors: [`File is too large. Limit is ${Math.round(limit / 1024 / 1024)}MB.`]
      }, { status: 400 });
    }
    await context.env.SUBMISSIONS_MEDIA.put(key, body, {
      httpMetadata: { contentType: validation.contentType },
      customMetadata: {
        originalFilename: validation.safeFilename,
        kind: validation.kind,
        eventSlug: context.params.slug,
        eventInstanceId: context.params.instanceId,
        uploadedAt: new Date().toISOString()
      }
    });
    const photo = await createEventPhotoRecord(db, {
      id,
      eventSlug: context.params.slug,
      eventInstanceId: context.params.instanceId,
      kind: validation.kind,
      storageKey: key,
      publicUrl: publicUrlFor(context.params.slug, context.params.instanceId, key),
      originalFilename: validation.safeFilename,
      contentType: validation.contentType,
      bytes: actualSize
    });
    return jsonResponse({ ok: true, photo }, { status: 201 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
