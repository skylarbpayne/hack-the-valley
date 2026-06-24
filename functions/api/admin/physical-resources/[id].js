import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin
} from "../../../_lib/event-platform.js";
import {
  attachPhysicalResourcePhoto,
  checkoutPhysicalResource,
  getPhysicalResource,
  listPhysicalResourceCheckouts,
  retirePhysicalResource,
  returnPhysicalResource,
  updatePhysicalResource,
  validatePhysicalResourcePhotoUpload
} from "../../../_lib/domain/physical-resources.js";
import { appendAuditEvent, buildAuditEvent } from "../../../_lib/domain/audit.js";
import { corsHeaders, maxUploadBytes, randomId } from "../../../_shared/submissions.js";

function requireSessionAdmin(access) {
  if (access?.bootstrap || !access?.user?.id) {
    throw Object.assign(new Error("A signed-in admin session is required."), { status: 403 });
  }
  return access;
}

function actorId(access) {
  return access?.user?.id || null;
}

async function auditResourceChange(db, { action, access, resource, checkout = null, metadata = {} }) {
  await appendAuditEvent(db, buildAuditEvent({
    action,
    actorUserId: actorId(access),
    targetType: "physical_resource",
    targetId: resource?.id,
    scopeType: "physical_resource",
    scopeId: resource?.id,
    metadata: {
      source: "admin-physical-resources",
      resourceName: resource?.name,
      resourceStatus: resource?.status,
      checkoutId: checkout?.id,
      holderUserId: checkout?.holderUserId,
      holderEmail: checkout?.holderEmail,
      ...metadata
    }
  }));
}

function resourceId(context) {
  const id = context.params?.id;
  if (!id) throw Object.assign(new Error("Physical resource id is required."), { status: 400 });
  return id;
}

function checkoutAction(input = {}) {
  return String(input.action || input.type || "checkout").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function uploadFilename(request, url) {
  return url.searchParams.get("filename") || request.headers.get("x-filename") || "resource-photo";
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    requireSessionAdmin(await requireAdmin(context.request, context.env));
    const db = getDb(context.env);
    const id = resourceId(context);
    if (context.params?.action === "checkouts") {
      const url = new URL(context.request.url);
      const checkouts = await listPhysicalResourceCheckouts(db, id, { limit: url.searchParams.get("limit") || 50 });
      return jsonResponse({ ok: true, checkouts, count: checkouts.length });
    }
    if (context.params?.action === "photo") {
      if (!context.env.SUBMISSIONS_MEDIA) throw Object.assign(new Error("Upload storage is not configured."), { status: 503 });
      const resource = await getPhysicalResource(db, id);
      if (!resource) throw Object.assign(new Error("Physical resource not found."), { status: 404 });
      if (!resource.photoStorageKey) throw Object.assign(new Error("Physical resource photo not found."), { status: 404 });
      const object = await context.env.SUBMISSIONS_MEDIA.get(resource.photoStorageKey);
      if (!object) throw Object.assign(new Error("Physical resource photo not found."), { status: 404 });
      const headers = new Headers(corsHeaders());
      object.writeHttpMetadata?.(headers);
      if (!headers.get("content-type")) headers.set("content-type", resource.photoContentType || "application/octet-stream");
      if (object.httpEtag) headers.set("etag", object.httpEtag);
      headers.set("cache-control", "private, no-store");
      headers.set("x-content-type-options", "nosniff");
      headers.set("content-disposition", `inline; filename="${String(resource.photoOriginalFilename || "resource-photo").replace(/["\\]/g, "")}"`);
      return new Response(object.body, { headers });
    }
    const resource = await getPhysicalResource(db, id);
    if (!resource) throw Object.assign(new Error("Physical resource not found."), { status: 404 });
    const checkouts = await listPhysicalResourceCheckouts(db, id, { limit: 50 });
    return jsonResponse({ ok: true, resource, checkouts });
  });
}

export async function onRequestPatch(context) {
  return handleErrors(async () => {
    const access = requireSessionAdmin(await requireAdmin(context.request, context.env));
    if (context.params?.action) return methodNotAllowed(["GET", "POST"]);
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const resource = await updatePhysicalResource(db, resourceId(context), input, { actorUserId: actorId(access) });
    await auditResourceChange(db, { action: "physical_resource.update", access, resource });
    return jsonResponse({ ok: true, resource });
  });
}

export async function onRequestDelete(context) {
  return handleErrors(async () => {
    const access = requireSessionAdmin(await requireAdmin(context.request, context.env));
    if (context.params?.action) return methodNotAllowed(["GET", "POST"]);
    const db = getDb(context.env);
    const resource = await retirePhysicalResource(db, resourceId(context), { actorUserId: actorId(access) });
    await auditResourceChange(db, { action: "physical_resource.retire", access, resource });
    return jsonResponse({ ok: true, resource });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = requireSessionAdmin(await requireAdmin(context.request, context.env));
    const db = getDb(context.env);
    const id = resourceId(context);
    if (context.params?.action === "photo") {
      if (!context.env.SUBMISSIONS_MEDIA) throw Object.assign(new Error("Upload storage is not configured."), { status: 503 });
      const url = new URL(context.request.url);
      const upload = validatePhysicalResourcePhotoUpload({
        filename: uploadFilename(context.request, url),
        contentType: context.request.headers.get("content-type"),
        contentLength: context.request.headers.get("content-length"),
        maxBytes: maxUploadBytes(context.env),
        id: randomId("rpho")
      });
      if (!upload.ok) return jsonResponse({ error: upload.error, errors: upload.errors }, { status: 400 });
      const body = await context.request.arrayBuffer();
      const actualBytes = body.byteLength;
      const limit = maxUploadBytes(context.env);
      if (actualBytes > limit) {
        return jsonResponse({ error: "Upload rejected.", errors: [`Photo is too large. Limit is ${Math.round(limit / 1024 / 1024)}MB.`] }, { status: 400 });
      }
      await context.env.SUBMISSIONS_MEDIA.put(upload.key, body, {
        httpMetadata: { contentType: upload.contentType },
        customMetadata: { originalFilename: upload.safeFilename, physicalResourceId: id, uploadedByUserId: actorId(access) || "" }
      });
      const resource = await attachPhysicalResourcePhoto(db, id, { ...upload, bytes: actualBytes }, { actorUserId: actorId(access) });
      await auditResourceChange(db, { action: "physical_resource.photo_upload", access, resource, metadata: { photoStorageKey: upload.key, photoBytes: actualBytes } });
      return jsonResponse({ ok: true, resource });
    }
    if (context.params?.action !== "checkouts") return methodNotAllowed(["GET", "PATCH", "DELETE"]);
    const input = await readJson(context.request);
    const action = checkoutAction(input);
    if (action === "checkout" || action === "assign") {
      const result = await checkoutPhysicalResource(db, id, input, { actorUserId: actorId(access) });
      await auditResourceChange(db, { action: "physical_resource.checkout", access, resource: result.resource, checkout: result.checkout });
      return jsonResponse({ ok: true, ...result }, { status: 201 });
    }
    if (action === "return" || action === "checkin" || action === "check_in") {
      const result = await returnPhysicalResource(db, id, input, { actorUserId: actorId(access) });
      await auditResourceChange(db, { action: "physical_resource.return", access, resource: result.resource, checkout: result.checkout });
      return jsonResponse({ ok: true, ...result });
    }
    throw Object.assign(new Error("checkout action must be checkout or return."), { status: 400 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "PATCH", "DELETE", "POST"]);
}
