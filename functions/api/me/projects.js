import {
  getCurrentUserFromSession,
  getDb,
  getUserCommunityState,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson
} from "../../_lib/event-platform.js";
import {
  claimProjectForUser,
  createProjectMediaUploadRecord,
  maxProjectMediaBytes,
  prepareOwnedProjectMediaUpload,
  updateOwnedProjectForUser,
  verifyOwnedProjectMaterialUploads
} from "../../_lib/domain/projects.js";
import { submitOwnedProjectToEvent } from "../../_lib/domain/submissions.js";
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

async function existingProjectMaterials(db, project, user) {
  if (!project?.canonical_submission_id) return { uploads: [], mediaLink: "" };
  const row = await db.prepare("SELECT payload_json, uploads_json FROM submissions WHERE id = ?").bind(project.canonical_submission_id).first();
  let payload = {};
  try {
    payload = row?.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  const existingUploads = parseJsonArray(row?.uploads_json);
  let verifiedUploads = [];
  if (existingUploads.length && project?.id && user?.id) {
    try {
      verifiedUploads = await verifyOwnedProjectMaterialUploads(db, {
        projectId: project.id,
        userId: user.id,
        uploads: existingUploads
      });
    } catch {
      verifiedUploads = [];
    }
  }
  return {
    uploads: verifiedUploads,
    mediaLink: payload.mediaLink || payload.media_link || ""
  };
}

async function saveOwnedProjectMaterials(context, db, user, projectId, input) {
  const verifiedUploads = await verifyOwnedProjectMaterialUploads(db, {
    projectId,
    userId: user.id,
    uploads: Array.isArray(input.uploads) ? input.uploads : []
  });
  const updated = await updateOwnedProjectForUser(db, user.id, projectId, input);
  const existingMaterials = await existingProjectMaterials(db, updated.project, user);
  const newUploads = verifiedUploads;
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
  }, { allowCanonicalSubmissionId: true });
  await db.prepare(`
    UPDATE event_project_submissions
    SET submission_id = ?, updated_at = ?
    WHERE project_id = ? AND status != 'hidden'
  `).bind(submission.id, new Date().toISOString(), projectId).run();
  const state = await getUserCommunityState(db, user.id);
  return { submission, state };
}

function parseContentLengthHeader(request) {
  const raw = request.headers.get("content-length") || "";
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : -1;
}

function bytesStartWith(bytes, values, offset = 0) {
  if (bytes.length < offset + values.length) return false;
  return values.every((value, index) => bytes[offset + index] === value);
}

function asciiAt(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function bodyMatchesDeclaredType(contentType, body) {
  const bytes = new Uint8Array(body);
  if (!bytes.length) return false;
  if (contentType === "image/png") return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (contentType === "image/jpeg") return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
  if (contentType === "image/gif") return asciiAt(bytes, 0, 6) === "GIF87a" || asciiAt(bytes, 0, 6) === "GIF89a";
  if (contentType === "image/webp") return asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP";
  if (contentType === "application/pdf") return asciiAt(bytes, 0, 5) === "%PDF-";
  if (contentType === "application/zip" || contentType === "application/x-zip-compressed") {
    return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])
      || bytesStartWith(bytes, [0x50, 0x4b, 0x05, 0x06])
      || bytesStartWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
  }
  if (contentType === "video/webm") return bytesStartWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  if (contentType === "video/mp4" || contentType === "video/quicktime") return asciiAt(bytes, 4, 4) === "ftyp";
  return true;
}

function assertBodyMatchesDeclaredType(contentType, body) {
  if (!bodyMatchesDeclaredType(contentType, body)) {
    throw Object.assign(new Error("Upload content does not match the declared file type."), { status: 400 });
  }
}

async function uploadOwnedProjectMedia(context, db, user, projectId) {
  if (!context.env.SUBMISSIONS_MEDIA) {
    throw Object.assign(new Error("Upload storage is not configured."), { status: 503 });
  }
  const url = new URL(context.request.url);
  const declaredContentLength = parseContentLengthHeader(context.request);
  const maxBytes = maxProjectMediaBytes(context.env);
  if (declaredContentLength < 0) {
    throw Object.assign(new Error("Content-Length must be a valid number."), { status: 400 });
  }
  if (declaredContentLength > maxBytes) {
    throw Object.assign(new Error(`File is too large. Limit is ${Math.round(maxBytes / 1024 / 1024)}MB; paste a YouTube/Loom/Drive link for larger videos.`), { status: 413 });
  }
  const body = await context.request.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw Object.assign(new Error(`File is too large. Limit is ${Math.round(maxBytes / 1024 / 1024)}MB; paste a YouTube/Loom/Drive link for larger videos.`), { status: 413 });
  }
  const contentType = context.request.headers.get("content-type") || "";
  const upload = await prepareOwnedProjectMediaUpload(db, {
    projectId,
    user,
    sessionId: user.session_id || null,
    filename: url.searchParams.get("filename") || context.request.headers.get("x-filename") || "project-media",
    kind: url.searchParams.get("kind") || context.request.headers.get("x-upload-kind") || "artifact",
    contentType,
    contentLength: body.byteLength,
    env: context.env,
    eventSlug: url.searchParams.get("event") || url.searchParams.get("eventSlug") || context.env.HTV_DEFAULT_PROJECT_EVENT_SLUG || null,
    eventInstanceId: url.searchParams.get("eventInstanceId") || url.searchParams.get("event_instance_id") || null
  });
  assertBodyMatchesDeclaredType(upload.contentType, body);
  await context.env.SUBMISSIONS_MEDIA.put(upload.key, body, {
    httpMetadata: { contentType: upload.contentType },
    customMetadata: upload.metadata
  });
  await createProjectMediaUploadRecord(db, upload);
  return {
    key: upload.key,
    kind: upload.kind,
    filename: upload.filename,
    contentType: upload.contentType,
    size: upload.size,
    uploadedAt: upload.uploadedAt,
    projectId: upload.projectId
  };
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const { db, user } = await signedInUser(context);
    const state = await getUserCommunityState(db, user.id);
    return jsonResponse({ ok: true, ...state }, { status: 200 });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const { db, user } = await signedInUser(context);
    if (context.params?.projectId && context.params?.action === "media") {
      const upload = await uploadOwnedProjectMedia(context, db, user, context.params.projectId);
      return jsonResponse({ ok: true, upload }, { status: 201 });
    }
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
  return methodNotAllowed(["GET", "POST", "PATCH", "PUT"]);
}
