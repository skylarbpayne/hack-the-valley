import {
  getDb,
  handleErrors,
  listPublicProjects,
  methodNotAllowed
} from "../_lib/event-platform.js";
import { jsonResponse, optionsResponse } from "../_shared/submissions.js";

export function onRequestOptions() {
  return optionsResponse();
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const url = new URL(context.request.url);
    const eventSlug = url.searchParams.get("event") || context.env.HTV_DEFAULT_PROJECT_EVENT_SLUG || "hack-the-valley-2026";
    const projects = await listPublicProjects(getDb(context.env), { eventSlug });
    return jsonResponse({ ok: true, event_slug: eventSlug, projects, count: projects.length });
  });
}

export async function onRequest() {
  return methodNotAllowed(["GET", "OPTIONS"]);
}
