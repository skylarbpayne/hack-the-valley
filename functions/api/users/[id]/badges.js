import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireOrganizerAccess
} from "../../../_lib/event-platform.js";
import {
  awardPersonBadgeFromAdminRoute,
  listPersonBadgesForAdminRoute,
  revokePersonBadgeFromAdminRoute
} from "../../../_lib/domain/badges.js";

async function readOptionalJson(request) {
  const contentType = request.headers.get("content-type") || "";
  const hasJsonBody = contentType.includes("application/json");
  if (!hasJsonBody) return {};
  return await readJson(request);
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    const badges = await listPersonBadgesForAdminRoute(getDb(context.env), { personId: context.params.id });
    return jsonResponse({ ok: true, badges });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = await requireOrganizerAccess(context.request, context.env);
    const body = await readJson(context.request);
    const result = await awardPersonBadgeFromAdminRoute(getDb(context.env), {
      personId: context.params.id,
      input: body,
      access
    });
    return jsonResponse({ ok: true, ...result });
  });
}

export async function onRequestDelete(context) {
  return handleErrors(async () => {
    const access = await requireOrganizerAccess(context.request, context.env);
    const url = new URL(context.request.url);
    const body = await readOptionalJson(context.request);
    const result = await revokePersonBadgeFromAdminRoute(getDb(context.env), {
      input: body,
      query: url.searchParams,
      access
    });
    return jsonResponse({ ok: true, ...result });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST", "DELETE"]);
}
