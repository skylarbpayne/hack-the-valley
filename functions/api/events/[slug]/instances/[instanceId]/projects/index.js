import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireOrganizerAccess
} from "../../../../../../_lib/event-platform.js";
import {
  listOrganizerEventProjectSubmissions,
  submitEventInstanceProjectSubmission
} from "../../../../../../_lib/domain/submissions.js";

function trustedOrganizerSource(access = {}) {
  if (access.user?.id) return `organizer:${access.user.id}`;
  return access.bootstrap ? "bootstrap_admin" : "organizer";
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    const db = getDb(context.env);
    const projects = await listOrganizerEventProjectSubmissions(db, {
      eventSlug: context.params.slug,
      eventInstanceId: context.params.instanceId
    });
    return jsonResponse({ projects, count: projects.length });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = await requireOrganizerAccess(context.request, context.env);
    const db = getDb(context.env);
    const body = await readJson(context.request);
    const project = await submitEventInstanceProjectSubmission(db, {
      eventSlug: context.params.slug,
      eventInstanceId: context.params.instanceId,
      input: body,
      source: trustedOrganizerSource(access)
    });
    return jsonResponse({ ok: true, project });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
