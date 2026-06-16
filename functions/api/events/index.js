import {
  getDb,
  handleErrors,
  jsonResponse,
  listEvents,
  methodNotAllowed,
  readJson,
  requireAdmin,
  upsertEvent
} from "../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const url = new URL(context.request.url);
    const includeArchived = url.searchParams.get("include_archived") === "1";
    const db = getDb(context.env);
    const events = await listEvents(db, { includeArchived });
    return jsonResponse({ events });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const event = await upsertEvent(db, input);
    return jsonResponse({ success: true, event }, { status: 201 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
