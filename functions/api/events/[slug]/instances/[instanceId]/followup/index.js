import {
  getDb,
  getEventFollowupPacket,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireOrganizerAccess
} from "../../../../../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    const db = getDb(context.env);
    const packet = await getEventFollowupPacket(db, context.params.slug, context.params.instanceId);
    return jsonResponse(packet);
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
