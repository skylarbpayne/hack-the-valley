import {
  getDb,
  getUserCommunityState,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin
} from "../../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const state = await getUserCommunityState(db, context.params.id);
    return jsonResponse(state);
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
