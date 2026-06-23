import {
  getDb,
  getEventSeries,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
  upsertEvent
} from "../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const db = getDb(context.env);
    const event = await getEventSeries(db, context.params.slug);
    if (!event || event.status === "archived") {
      return jsonResponse({ error: "Event not found" }, { status: 404 });
    }
    return jsonResponse({ event });
  });
}

export async function onRequestPatch(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const existing = await getEventSeries(db, context.params.slug);
    if (!existing) return jsonResponse({ error: "Event not found" }, { status: 404 });
    const input = await readJson(context.request);
    const event = await upsertEvent(db, { ...input, slug: existing.slug }, existing);
    return jsonResponse({ success: true, event });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "PATCH"]);
}
