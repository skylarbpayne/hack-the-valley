import {
  awardBadge,
  getDb,
  handleErrors,
  jsonResponse,
  listPersonBadges,
  methodNotAllowed,
  readJson,
  requireOrganizerAccess,
  revokeBadgeAward
} from "../../../_lib/event-platform.js";

async function readOptionalJson(request) {
  const contentType = request.headers.get("content-type") || "";
  const hasJsonBody = contentType.includes("application/json");
  if (!hasJsonBody) return {};
  return await readJson(request);
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    const badges = await listPersonBadges(getDb(context.env), context.params.id);
    return jsonResponse({ ok: true, badges });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = await requireOrganizerAccess(context.request, context.env);
    const body = await readJson(context.request);
    const result = await awardBadge(getDb(context.env), {
      personId: context.params.id,
      badgeSlug: body.badge_slug || body.badgeSlug || body.slug,
      badge: body.badge,
      eventInstanceId: body.event_instance_id || body.eventInstanceId || null,
      projectId: body.project_id || body.projectId || null,
      source: "admin",
      awardedBy: access.user?.id || null
    });
    return jsonResponse({ ok: true, ...result });
  });
}

export async function onRequestDelete(context) {
  return handleErrors(async () => {
    const access = await requireOrganizerAccess(context.request, context.env);
    const url = new URL(context.request.url);
    const body = await readOptionalJson(context.request);
    const result = await revokeBadgeAward(getDb(context.env), {
      awardId: body.award_id || body.awardId || url.searchParams.get("award_id") || url.searchParams.get("awardId"),
      actorUserId: access.user?.id || null,
      reason: body.reason || body.revoke_reason || url.searchParams.get("reason") || url.searchParams.get("revoke_reason")
    });
    return jsonResponse({ ok: true, ...result });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST", "DELETE"]);
}
