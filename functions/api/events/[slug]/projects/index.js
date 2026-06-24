import {
  getDb,
  handleErrors,
  methodNotAllowed
} from "../../../../_lib/event-platform.js";
import { listEventProjectReviewSubmissions } from "../../../../_lib/domain/submissions.js";
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

export async function onRequestGet(context) {
  return withCors(handleErrors(async () => {
    requireSubmissionAdmin(context.request, context.env);
    const db = getDb(context.env);
    const projects = await listEventProjectReviewSubmissions(db, { eventSlug: context.params.slug });
    return jsonResponse({ ok: true, projects, count: projects.length });
  }));
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "OPTIONS"]);
}
