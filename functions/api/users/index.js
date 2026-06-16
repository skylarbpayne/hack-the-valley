import {
  getDb,
  handleErrors,
  jsonResponse,
  listUsers,
  methodNotAllowed,
  requireAdmin
} from "../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const url = new URL(context.request.url);
    const users = await listUsers(getDb(context.env), { limit: url.searchParams.get("limit") || 500 });
    return jsonResponse({ users, count: users.length });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
