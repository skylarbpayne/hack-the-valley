import {
  getDb,
  handleErrors,
  methodNotAllowed,
  readJson
} from "../../../../_lib/event-platform.js";
import { updateEventProjectSubmissionStatus } from "../../../../_lib/domain/submissions.js";
import {
  isAuthorized,
  jsonResponse,
  optionsResponse
} from "../../../../_shared/submissions.js";

function requireSubmissionAdmin(request, env) {
  if (!isAuthorized(request, env)) throw Object.assign(new Error("Admin token required."), { status: 401 });
}

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

export async function onRequestPatch(context) {
  return withCors(handleErrors(async () => {
    requireSubmissionAdmin(context.request, context.env);
    const db = getDb(context.env);
    const body = await readJson(context.request);
    const project = await updateEventProjectSubmissionStatus(db, {
      eventSlug: context.params.slug,
      projectId: context.params.projectId,
      status: body.status || "hidden"
    });
    return jsonResponse({ ok: true, project });
  }));
}

export async function onRequestDelete(context) {
  return withCors(handleErrors(async () => {
    requireSubmissionAdmin(context.request, context.env);
    const db = getDb(context.env);
    const project = await updateEventProjectSubmissionStatus(db, {
      eventSlug: context.params.slug,
      projectId: context.params.projectId,
      status: "hidden"
    });
    return jsonResponse({ ok: true, project, message: "Project submission hidden from event review/showcase." });
  }));
}

export async function onRequest(context) {
  return methodNotAllowed(["PATCH", "DELETE", "OPTIONS"]);
}
