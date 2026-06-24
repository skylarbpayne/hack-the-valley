import {
  getDb,
  getEventSeries,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin
} from "../../_lib/event-platform.js";
import { updateEventSeriesFromAdminRoute } from "../../_lib/domain/events.js";

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
    const access = await requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const event = await updateEventSeriesFromAdminRoute(db, {
      slug: context.params.slug,
      input,
      access
    });
    return jsonResponse({ success: true, event });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "PATCH"]);
}
