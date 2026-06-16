import {
  getDb,
  getUserCommunityState,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireOrganizerAccess
} from "../../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    const db = getDb(context.env);
    const state = await getUserCommunityState(db, context.params.id);
    return jsonResponse(state);
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
