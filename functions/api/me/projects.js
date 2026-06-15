import {
  claimProjectForUser,
  getCurrentUserFromSession,
  getDb,
  getUserCommunityState,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  submitOwnedProjectToEvent,
  updateOwnedProjectForUser
} from "../../_lib/event-platform.js";
import {
  insertSubmission,
  normalizeSubmissionTracks,
  validateSubmission
} from "../../_shared/submissions.js";

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

async function signedInUser(context) {
  const db = getDb(context.env);
  const token = cookieValue(context.request, "htv_session") || context.request.headers.get("x-htv-session") || "";
  const user = await getCurrentUserFromSession(db, token);
  if (!user) throw Object.assign(new Error("Not signed in"), { status: 401 });
  return { db, user };
}

function safeTracks(project) {
  try {
    return normalizeSubmissionTracks(JSON.parse(project.tracks_json || "[]"));
  } catch {
    return [];
  }
}

function materialPayloadForProject(project, user, input = {}) {
  return {
    teamName: project.team_name || project.title,
    projectTitle: project.title,
    contactEmail: user.email,
    members: input.members || [user.name, user.email].filter(Boolean).join(" — "),
    description: project.description || input.description || "Project materials uploaded from the participant projects workspace.",
    repoLink: project.repo_url || "",
    demoLink: project.demo_url || "",
    mediaLink: input.mediaLink || input.media_link || "",
    tracks: input.tracks || safeTracks(project),
    uploads: Array.isArray(input.uploads) ? input.uploads : []
  };
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function existingProjectMaterials(db, project) {
  if (!project?.canonical_submission_id) return { uploads: [], mediaLink: "" };
  const row = await db.prepare("SELECT payload_json, uploads_json FROM submissions WHERE id = ?").bind(project.canonical_submission_id).first();
  let payload = {};
  try {
    payload = row?.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  return {
    uploads: parseJsonArray(row?.uploads_json),
    mediaLink: payload.mediaLink || payload.media_link || ""
  };
}

async function saveOwnedProjectMaterials(context, db, user, projectId, input) {
  const updated = await updateOwnedProjectForUser(db, user.id, projectId, input);
  const existingMaterials = await existingProjectMaterials(db, updated.project);
  const newUploads = Array.isArray(input.uploads) ? input.uploads : [];
  const payload = materialPayloadForProject(updated.project, user, {
    ...input,
    mediaLink: input.mediaLink || input.media_link || existingMaterials.mediaLink,
    uploads: [...existingMaterials.uploads, ...newUploads]
  });
  const validation = validateSubmission(payload);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.errors.join("; ")), { status: 400, errors: validation.errors });
  }
  const submission = await insertSubmission(context.env, payload, validation.uploads);
  await updateOwnedProjectForUser(db, user.id, projectId, {
    ...updated.project,
    canonical_submission_id: submission.id
  });
  await db.prepare(`
    UPDATE event_project_submissions
    SET submission_id = ?, updated_at = ?
    WHERE project_id = ? AND status != 'hidden'
  `).bind(submission.id, new Date().toISOString(), projectId).run();
  const state = await getUserCommunityState(db, user.id);
  return { submission, state };
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const { db, user } = await signedInUser(context);
    const input = await readJson(context.request);
    if (context.params?.projectId && context.params?.action === "materials") {
      const saved = await saveOwnedProjectMaterials(context, db, user, context.params.projectId, input);
      return jsonResponse({ ok: true, ...saved }, { status: 200 });
    }
    if (context.params?.projectId) {
      const submitted = await submitOwnedProjectToEvent(db, user.id, context.params.projectId, input);
      const state = await getUserCommunityState(db, user.id);
      return jsonResponse({ ok: true, ...submitted, state }, { status: 200 });
    }
    const claimed = await claimProjectForUser(db, user.id, input);
    let submission = null;
    const eventSlug = input.event_slug || input.eventSlug;
    if (eventSlug) {
      const submitted = await submitOwnedProjectToEvent(db, user.id, claimed.project.id, {
        event_slug: eventSlug,
        event_instance_id: input.event_instance_id || input.eventInstanceId || null,
        status: input.status || "submitted"
      });
      submission = submitted.submission;
    }
    const state = await getUserCommunityState(db, user.id);
    return jsonResponse({ ok: true, ...claimed, submission, state }, { status: 200 });
  });
}

export async function onRequestPatch(context) {
  return handleErrors(async () => {
    const { db, user } = await signedInUser(context);
    const input = await readJson(context.request);
    const projectId = context.params?.projectId || input.project_id || input.projectId;
    const updated = await updateOwnedProjectForUser(db, user.id, projectId, input);
    const state = await getUserCommunityState(db, user.id);
    return jsonResponse({ ok: true, ...updated, state }, { status: 200 });
  });
}

export async function onRequestPut(context) {
  return handleErrors(async () => {
    const { db, user } = await signedInUser(context);
    const input = await readJson(context.request);
    const projectId = context.params?.projectId || input.project_id || input.projectId;
    const submitted = await submitOwnedProjectToEvent(db, user.id, projectId, input);
    const state = await getUserCommunityState(db, user.id);
    return jsonResponse({ ok: true, ...submitted, state }, { status: 200 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["POST", "PATCH", "PUT"]);
}
