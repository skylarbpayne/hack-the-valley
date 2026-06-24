import {
  getDb,
  handleErrors,
  methodNotAllowed
} from "../_lib/event-platform.js";
import { getPublicProject, listPublicProjects } from "../_lib/domain/submissions.js";
import { errorResponse, jsonResponse, optionsResponse } from "../_shared/submissions.js";

export function onRequestOptions() {
  return optionsResponse();
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const url = new URL(context.request.url);
    const eventSlug = context.params?.eventSlug || url.searchParams.get("event") || "";
    const projectSlug = context.params?.projectSlug || url.searchParams.get("project") || url.searchParams.get("slug") || "";
    const db = getDb(context.env);
    if (projectSlug) {
      const project = await getPublicProject(db, { eventSlug, projectSlug });
      if (!project) return errorResponse("Project not found.", 404);
      return jsonResponse({ ok: true, event_slug: eventSlug, project });
    }
    const projects = await listPublicProjects(db, { eventSlug });
    return jsonResponse({ ok: true, event_slug: eventSlug, projects, count: projects.length });
  });
}

export async function onRequest() {
  return methodNotAllowed(["GET", "OPTIONS"]);
}
