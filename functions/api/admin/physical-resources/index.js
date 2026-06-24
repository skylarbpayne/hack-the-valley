import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin
} from "../../../_lib/event-platform.js";
import {
  createPhysicalResource,
  listPhysicalResources
} from "../../../_lib/domain/physical-resources.js";
import { appendAuditEvent, buildAuditEvent } from "../../../_lib/domain/audit.js";

function requireSessionAdmin(access) {
  if (access?.bootstrap || !access?.user?.id) {
    throw Object.assign(new Error("A signed-in admin session is required."), { status: 403 });
  }
  return access;
}

function actorId(access) {
  return access?.user?.id || null;
}

async function auditResourceChange(db, { action, access, resource, metadata = {} }) {
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
      ...metadata
    }
  }));
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    requireSessionAdmin(await requireAdmin(context.request, context.env));
    const db = getDb(context.env);
    const url = new URL(context.request.url);
    const resources = await listPhysicalResources(db, {
      status: url.searchParams.get("status"),
      query: url.searchParams.get("q") || url.searchParams.get("query"),
      includeRetired: ["1", "true", "yes"].includes(String(url.searchParams.get("include_retired") || "").toLowerCase()),
      limit: url.searchParams.get("limit") || 100
    });
    return jsonResponse({ ok: true, resources, count: resources.length });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = requireSessionAdmin(await requireAdmin(context.request, context.env));
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const resource = await createPhysicalResource(db, input, { actorUserId: actorId(access) });
    await auditResourceChange(db, { action: "physical_resource.create", access, resource });
    return jsonResponse({ ok: true, resource }, { status: 201 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
