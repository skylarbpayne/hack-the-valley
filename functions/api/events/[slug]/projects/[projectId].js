import {
  getDb,
  handleErrors,
  methodNotAllowed,
  readJson,
  requireOrganizerAccess
} from "../../../../_lib/event-platform.js";
import { updateEventProjectReviewSubmissionStatus } from "../../../../_lib/domain/submissions.js";
import { appendAuditEvent, buildAuditEvent } from "../../../../_lib/domain/audit.js";
import {
  isAuthorized,
  jsonResponse,
  optionsResponse
} from "../../../../_shared/submissions.js";

async function withCors(promise) {
  const response = await promise;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  headers.set('access-control-allow-headers', 'authorization, content-type, x-admin-token, x-filename, x-project-title, x-team-name, x-upload-kind');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function onRequestOptions() {
  return optionsResponse();
}

function routeSubmissionId(body = {}) {
  return body.event_project_submission_id || body.eventProjectSubmissionId || null;
}

function routeEventInstanceId(request, body = {}) {
  const url = new URL(request.url);
  return body.event_instance_id || body.eventInstanceId || url.searchParams.get("instance_id") || url.searchParams.get("event_instance_id") || null;
}

async function requireProjectReviewStatusAccess(context) {
  try {
    return await requireOrganizerAccess(context.request, context.env, { scopeType: "event", scopeId: context.params.slug });
  } catch (error) {
    if (!isAuthorized(context.request, context.env)) throw error;
    return {
      user: null,
      role: { role: "submission_admin_token" },
      legacyToken: true
    };
  }
}

async function appendStatusAudit(db, { access, context, project, status }) {
  await appendAuditEvent(db, buildAuditEvent({
    action: "event_project_submission.status_update",
    actorUserId: access.user?.id || null,
    targetType: "event_project_submission",
    targetId: project.event_project_submission_id || project.id,
    scopeType: "event",
    scopeId: context.params.slug,
    metadata: {
      projectId: project.project_id || context.params.projectId,
      pathProjectId: context.params.projectId,
      eventInstanceId: project.event_instance_id || null,
      status,
      role: access.role?.role || null,
      legacyToken: access.legacyToken === true
    }
  }));
}

export async function onRequestPatch(context) {
  return withCors(handleErrors(async () => {
    const access = await requireProjectReviewStatusAccess(context);
    const db = getDb(context.env);
    const body = await readJson(context.request);
    const project = await updateEventProjectReviewSubmissionStatus(db, {
      eventSlug: context.params.slug,
      projectId: context.params.projectId,
      eventInstanceId: routeEventInstanceId(context.request, body),
      submissionId: routeSubmissionId(body),
      status: body.status || "hidden",
      actor: access.user?.id || null
    });
    await appendStatusAudit(db, { access, context, project, status: project.status });
    return jsonResponse({ ok: true, project });
  }));
}

export async function onRequestDelete(context) {
  return withCors(handleErrors(async () => {
    const access = await requireProjectReviewStatusAccess(context);
    const db = getDb(context.env);
    const url = new URL(context.request.url);
    const project = await updateEventProjectReviewSubmissionStatus(db, {
      eventSlug: context.params.slug,
      projectId: context.params.projectId,
      eventInstanceId: url.searchParams.get("instance_id") || url.searchParams.get("event_instance_id"),
      submissionId: url.searchParams.get("event_project_submission_id"),
      status: "hidden",
      actor: access.user?.id || null
    });
    await appendStatusAudit(db, { access, context, project, status: project.status });
    return jsonResponse({ ok: true, project, message: "Project submission hidden from event review/showcase." });
  }));
}

export async function onRequest(context) {
  return methodNotAllowed(["PATCH", "DELETE", "OPTIONS"]);
}
