import {
  awardBadge,
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireOrganizerAccess
} from "../../../_lib/event-platform.js";

export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    const body = await readJson(context.request);
    const result = await awardBadge(getDb(context.env), {
      userId: context.params.id,
      badgeSlug: body.badge_slug || body.badgeSlug || body.slug,
      badge: body.badge,
      eventInstanceId: body.event_instance_id || body.eventInstanceId || null,
      projectId: body.project_id || body.projectId || null,
      source: body.source || "admin",
      awardedBy: body.awarded_by || body.awardedBy || null
    });
    return jsonResponse({ ok: true, ...result });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["POST"]);
}
