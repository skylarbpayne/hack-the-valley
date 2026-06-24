import {
  getDb,
  handleErrors,
  jsonResponse,
  listEventSeries,
  methodNotAllowed,
  readJson,
  requireAdmin
} from "../../_lib/event-platform.js";
import { createEventSeriesFromAdminRoute } from "../../_lib/domain/events.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const url = new URL(context.request.url);
    const includeArchived = url.searchParams.get("include_archived") === "1";
    const db = getDb(context.env);
    const events = await listEventSeries(db, { includeArchived });
    return jsonResponse({ events });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = await requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const event = await createEventSeriesFromAdminRoute(db, { input, access });
    return jsonResponse({ success: true, event }, { status: 201 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
