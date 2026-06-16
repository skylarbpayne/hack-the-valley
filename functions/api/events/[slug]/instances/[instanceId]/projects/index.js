import {
  getDb,
  handleErrors,
  jsonResponse,
  linkProjectSubmission,
  listEventProjectSubmissions,
  methodNotAllowed,
  readJson,
  requireOrganizerAccess,
  upsertProject,
  upsertProjectFromSubmission
} from "../../../../../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    const db = getDb(context.env);
    const projects = await listEventProjectSubmissions(db, context.params.slug, context.params.instanceId);
    return jsonResponse({ projects, count: projects.length });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireOrganizerAccess(context.request, context.env);
    const db = getDb(context.env);
    const body = await readJson(context.request);
    let project;
    if (body.submission_id) {
      project = await upsertProjectFromSubmission(db, body.submission_id, {
        eventSlug: context.params.slug,
        eventInstanceId: context.params.instanceId,
        status: body.status || "submitted"
      });
    } else {
      project = await upsertProject(db, body.project || body);
      await linkProjectSubmission(db, {
        eventSlug: context.params.slug,
        eventInstanceId: context.params.instanceId,
        projectId: project.id,
        submissionId: body.submission_id || body.submissionId || null,
        status: body.status || "submitted",
        source: body.source || "admin"
      });
    }
    return jsonResponse({ ok: true, project });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
