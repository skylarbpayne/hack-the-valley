import {
  getDb,
  getEventCockpit,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireOrganizerAccess
} from "../../../../../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    requireOrganizerAccess(context.request, context.env);
    const db = getDb(context.env);
    const cockpit = await getEventCockpit(db, context.params.slug, context.params.instanceId);
    return jsonResponse(cockpit);
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
