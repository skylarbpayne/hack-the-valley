import { parseJsonArray, stringOrNull } from "./shared.js";
import { randomId, sanitizeFilename } from "../../_shared/submissions.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_MEMBER_ROLES = new Set(["owner", "member", "mentor", "judge", "admin"]);
const PROJECT_MEDIA_KINDS = new Set(["image", "video", "artifact"]);
const PROJECT_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const PROJECT_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const PROJECT_ARTIFACT_TYPES = new Set(["application/pdf", "application/zip", "application/x-zip-compressed"]);
const PROJECT_MEDIA_EXTENSIONS = {
  "image/jpeg": new Set(["jpg", "jpeg"]),
  "image/png": new Set(["png"]),
  "image/webp": new Set(["webp"]),
  "image/gif": new Set(["gif"]),
  "video/mp4": new Set(["mp4"]),
  "video/webm": new Set(["webm"]),
  "video/quicktime": new Set(["mov", "qt"]),
  "application/pdf": new Set(["pdf"]),
  "application/zip": new Set(["zip"]),
  "application/x-zip-compressed": new Set(["zip"])
};
const DEFAULT_PROJECT_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_PROJECT_MEDIA_MAX_FILES = 10;

export function normalizeProjectInput(input = {}, existing = {}, options = {}) {
  const links = normalizeLinks(input.links);
  const title = firstPresent(input.title, input.project_title, input.projectTitle, existing.title);
  const slug = firstPresent(input.slug, existing.slug, slugify(title));
  const tracks = normalizeTracks(input.tracks ?? input.track ?? existing.tracks_json);
  const canonicalSubmissionId = options.allowCanonicalSubmissionId === true
    ? firstPresent(input.canonical_submission_id, input.submission_id, input.submissionId, existing.canonical_submission_id)
    : existing.canonical_submission_id || null;
  const project = {
    slug,
    title,
    team_name: firstPresent(input.team_name, input.teamName, input.team, existing.team_name),
    description: firstPresent(input.description, input.summary, existing.description),
    repo_url: firstPresent(input.repo_url, input.repoLink, input.repository_url, input.repository, links.repo_url, links.repository, existing.repo_url),
    demo_url: firstPresent(input.demo_url, input.demoLink, input.demo, links.demo_url, links.demo, existing.demo_url),
    tracks_json: stringifyJson(tracks),
    canonical_submission_id: canonicalSubmissionId
  };
  const errors = [];
  if (!project.title) errors.push("project title is required");
  if (!project.slug || !SLUG_RE.test(project.slug)) errors.push("project slug must use lowercase letters, numbers, and hyphens");
  return { project, errors };
}

export async function createProject(db, { ownerPerson = null, title, teamName, description, links = null, ...input } = {}) {
  const projectInput = {
    ...input,
    title,
    team_name: teamName ?? input.team_name ?? input.teamName,
    description: description ?? input.description,
    links: links ?? input.links
  };
  const ownerId = ownerPerson?.id || input.ownerPersonId || input.owner_person_id || null;
  const ownerEmail = ownerPerson?.email || input.ownerEmail || input.owner_email || null;
  const ownerName = ownerPerson?.name || displayName(ownerPerson) || input.ownerName || input.owner_name || null;
  const existing = await findProjectByInputSlug(db, projectInput);
  if (existing && (ownerId || ownerEmail)) {
    const membership = await findProjectMembership(db, existing.id, { id: ownerId, email: ownerEmail });
    if (!membership) throw Object.assign(new Error("Project slug already exists"), { status: 409 });
    const updated = await updateProject(db, { projectId: existing.id, actorPerson: { id: ownerId, email: ownerEmail }, patch: projectInput });
    return { ...updated, membership };
  }
  if (existing) throw Object.assign(new Error("Project slug already exists"), { status: 409 });

  const project = await upsertProject(db, projectInput);
  const result = { project: sanitizeProjectRow(project) };
  if (ownerId || ownerEmail) {
    result.membership = await addProjectMember(db, {
      projectId: project.id,
      personId: ownerId,
      email: ownerEmail,
      name: ownerName,
      role: "owner",
      source: input.source || "participant_dashboard"
    });
  }
  return result;
}

export async function upsertProject(db, input = {}, options = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  const { project, errors } = normalizeProjectInput(input, {}, { allowCanonicalSubmissionId: options.allowCanonicalSubmissionId === true });
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  const now = input.now || new Date().toISOString();
  const id = input.id && String(input.id).startsWith("prj_") ? String(input.id) : `prj_${project.slug.replace(/-/g, "_")}`;
  await db.prepare(`
    INSERT INTO projects (
      id, slug, title, team_name, description, repo_url, demo_url, tracks_json, canonical_submission_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      team_name = COALESCE(excluded.team_name, projects.team_name),
      description = COALESCE(excluded.description, projects.description),
      repo_url = COALESCE(excluded.repo_url, projects.repo_url),
      demo_url = COALESCE(excluded.demo_url, projects.demo_url),
      tracks_json = COALESCE(excluded.tracks_json, projects.tracks_json),
      canonical_submission_id = COALESCE(excluded.canonical_submission_id, projects.canonical_submission_id),
      updated_at = excluded.updated_at
  `).bind(
    id,
    project.slug,
    project.title,
    project.team_name,
    project.description,
    project.repo_url,
    project.demo_url,
    project.tracks_json,
    project.canonical_submission_id,
    now,
    now
  ).run();
  return await db.prepare("SELECT * FROM projects WHERE slug = ?").bind(project.slug).first()
    || { id, ...project, created_at: now, updated_at: now };
}

export async function updateProject(db, { projectId, actorPerson, patch = {}, now = new Date().toISOString(), allowCanonicalSubmissionId = false } = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  const existing = await getProjectForActor(db, projectId, actorPerson);
  const { project, errors } = normalizeProjectInput(patch, existing, { allowCanonicalSubmissionId });
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  await db.prepare(`
    UPDATE projects
    SET slug = ?,
        title = ?,
        team_name = ?,
        description = ?,
        repo_url = ?,
        demo_url = ?,
        tracks_json = ?,
        canonical_submission_id = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(
    project.slug,
    project.title,
    project.team_name,
    project.description,
    project.repo_url,
    project.demo_url,
    project.tracks_json,
    project.canonical_submission_id,
    now,
    existing.id
  ).run();
  const saved = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(existing.id).first();
  return { project: sanitizeProjectRow(saved || { ...existing, ...project, updated_at: now }) };
}

export async function addProjectMember(db, { projectId, personId = null, email = null, name = null, role = "member", source = "participant_dashboard", now = new Date().toISOString() } = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  if (!projectId) throw Object.assign(new Error("projectId is required"), { status: 400 });
  let person = personId ? await getUserById(db, personId) : null;
  const normalizedEmail = normalizeEmail(email || person?.email);
  if (!personId && !normalizedEmail) throw Object.assign(new Error("personId or email is required"), { status: 400 });
  if (normalizedEmail && !EMAIL_RE.test(normalizedEmail)) throw Object.assign(new Error("valid email is required"), { status: 400 });
  const normalizedRole = normalizeMemberRole(role);
  const memberName = stringOrNull(name) || displayName(person) || null;
  const id = `prm_${projectId}_${personId || normalizedEmail || now}`.replace(/[^a-zA-Z0-9_]+/g, "_");

  if (personId) {
    await db.prepare(`
      INSERT INTO project_members (
        id, project_id, user_id, name, email, role, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET
        name = COALESCE(excluded.name, project_members.name),
        email = COALESCE(excluded.email, project_members.email),
        role = CASE WHEN project_members.role = 'owner' THEN project_members.role ELSE excluded.role END,
        source = excluded.source
    `).bind(id, projectId, personId, memberName, normalizedEmail || null, normalizedRole, source, now).run();
    return await db.prepare("SELECT * FROM project_members WHERE project_id = ? AND user_id = ?").bind(projectId, personId).first()
      || { id, project_id: projectId, user_id: personId, name: memberName, email: normalizedEmail || null, role: normalizedRole, source, created_at: now };
  }

  await db.prepare(`
    INSERT INTO project_members (
      id, project_id, user_id, name, email, role, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, email) DO UPDATE SET
      name = COALESCE(excluded.name, project_members.name),
      role = CASE WHEN project_members.role = 'owner' THEN project_members.role ELSE excluded.role END,
      source = excluded.source
  `).bind(id, projectId, null, memberName, normalizedEmail, normalizedRole, source, now).run();
  return await db.prepare("SELECT * FROM project_members WHERE project_id = ? AND lower(email) = lower(?)").bind(projectId, normalizedEmail).first()
    || { id, project_id: projectId, user_id: null, name: memberName, email: normalizedEmail, role: normalizedRole, source, created_at: now };
}

export async function claimProjectForUser(db, userId, input = {}) {
  if (!userId) throw Object.assign(new Error("userId is required"), { status: 400 });
  const user = await getUserById(db, userId) || { id: userId, email: input.email || null, name: input.name || null };
  const existing = await findProjectByInputSlug(db, input);
  if (existing) {
    const membership = await findProjectMembership(db, existing.id, user);
    if (!membership) throw Object.assign(new Error("Project slug already exists"), { status: 409 });
    const updated = await updateProject(db, { projectId: existing.id, actorPerson: user, patch: input });
    return { ...updated, membership };
  }
  const project = await upsertProject(db, input);
  const membership = await addProjectMember(db, {
    projectId: project.id,
    personId: userId,
    email: user?.email || input.email || null,
    name: user?.name || input.name || null,
    role: "owner",
    source: input.source || "participant_dashboard"
  });
  return { project: sanitizeProjectRow(project), membership };
}

export async function updateOwnedProjectForUser(db, userId, projectId, input = {}, options = {}) {
  if (!userId) throw Object.assign(new Error("userId is required"), { status: 400 });
  const user = await getUserById(db, userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  return await updateProject(db, { projectId, actorPerson: user, patch: input, allowCanonicalSubmissionId: options.allowCanonicalSubmissionId === true });
}

export async function getOwnedProject(db, userId, projectId) {
  if (!userId) throw Object.assign(new Error("userId is required"), { status: 400 });
  const user = await getUserById(db, userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  return await getProjectForActor(db, projectId, user);
}

export async function prepareOwnedProjectMediaUpload(db, {
  projectId,
  user,
  sessionId = null,
  filename = "project-media",
  kind = "artifact",
  contentType = "",
  contentLength = 0,
  env = {},
  eventSlug = null,
  eventInstanceId = null,
  now = new Date()
} = {}) {
  if (!user?.id) throw Object.assign(new Error("signed-in user is required"), { status: 401 });
  const project = await getProjectForActor(db, projectId, user);
  await ensureProjectMediaUploadTable(db);
  const upload = validateAndBuildProjectMediaUpload({ project, user, sessionId, filename, kind, contentType, contentLength, env, eventSlug, eventInstanceId, now });
  if (!upload.ok) throw Object.assign(new Error("Upload rejected."), { status: 400, errors: upload.errors });

  const maxFiles = maxProjectMediaFiles(env);
  const countRow = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM project_media_uploads
    WHERE project_id = ?
  `).bind(project.id).first();
  const existingCount = Number(countRow?.count || 0);
  if (existingCount >= maxFiles) {
    throw Object.assign(new Error(`Project media upload limit reached (${maxFiles} files).`), { status: 400 });
  }

  return upload;
}

export async function createProjectMediaUploadRecord(db, upload = {}) {
  if (!upload?.key) throw Object.assign(new Error("upload key is required"), { status: 400 });
  await ensureProjectMediaUploadTable(db);
  await db.prepare(`
    INSERT INTO project_media_uploads (
      id, project_id, uploaded_by_user_id, session_id, event_slug, event_instance_id,
      storage_key, original_filename, content_type, kind, bytes, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    upload.id,
    upload.projectId,
    upload.uploadedByUserId,
    upload.sessionId,
    upload.eventSlug,
    upload.eventInstanceId,
    upload.key,
    upload.filename,
    upload.contentType,
    upload.kind,
    upload.size,
    JSON.stringify(upload.provenance || {}),
    upload.uploadedAt
  ).run();
  return upload;
}

export async function verifyOwnedProjectMaterialUploads(db, { projectId, userId, uploads = [] } = {}) {
  const uploadList = Array.isArray(uploads) ? uploads.filter((upload) => upload?.key) : [];
  if (!uploadList.length) return [];
  await ensureProjectMediaUploadTable(db);
  const verified = [];
  for (const upload of uploadList) {
    const key = String(upload.key || "").trim();
    const row = await db.prepare(`
      SELECT storage_key, original_filename, content_type, kind, bytes
      FROM project_media_uploads
      WHERE project_id = ?
        AND uploaded_by_user_id = ?
        AND storage_key = ?
      LIMIT 1
    `).bind(projectId, userId, key).first();
    if (!row) {
      throw Object.assign(new Error("Upload must be created by the signed-in project owner before it can be attached."), { status: 400 });
    }
    verified.push({
      key: row.storage_key,
      kind: row.kind || upload.kind || "artifact",
      filename: row.original_filename || upload.filename || "project-media",
      contentType: row.content_type || upload.contentType || upload.content_type || null,
      size: Number(row.bytes || upload.size || upload.bytes || 0) || null
    });
  }
  return verified;
}

export async function getProjectForActor(db, projectId, actorPerson = {}) {
  if (!projectId) throw Object.assign(new Error("project_id is required"), { status: 400 });
  const personId = actorPerson?.id || actorPerson?.user_id || null;
  const email = normalizeEmail(actorPerson?.email);
  if (!personId && !email) throw Object.assign(new Error("actorPerson.id or actorPerson.email is required"), { status: 400 });
  const project = await db.prepare(`
    SELECT p.*
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id
    WHERE p.id = ?
      AND (pm.user_id = ? OR lower(pm.email) = lower(?))
      AND pm.role IN ('owner', 'member', 'admin')
    LIMIT 1
  `).bind(projectId, personId || "", email || "").first();
  if (!project) throw Object.assign(new Error("Project not found for signed-in user"), { status: 404 });
  if (personId && email) {
    await db.prepare(`
      UPDATE project_members
      SET user_id = COALESCE(user_id, ?)
      WHERE project_id = ? AND user_id IS NULL AND lower(email) = lower(?)
    `).bind(personId, projectId, email).run();
  }
  return project;
}

export function sanitizeProjectRow(row = {}) {
  const { contact_email, payload_json, uploads_json, ...safe } = row || {};
  const payload = parseJsonObject(payload_json, {});
  const uploads = parseJsonArray(uploads_json).map((upload) => ({
    kind: upload.kind || "file",
    filename: upload.filename || upload.originalFilename || "Uploaded file",
    contentType: upload.contentType || upload.content_type || null,
    size: upload.size || upload.bytes || null
  }));
  safe.media_link = payload.mediaLink || payload.media_link || null;
  safe.uploads = uploads;
  safe.upload_count = uploads.length;
  safe.has_uploads = uploads.length > 0 || Boolean(safe.media_link);
  return safe;
}

export function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function normalizeLinks(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    return value.reduce((acc, link) => {
      const label = String(link?.label || link?.kind || link?.type || "").toLowerCase();
      const url = stringOrNull(link?.url || link?.href);
      if (!url) return acc;
      if (label.includes("repo") || label.includes("github") || label.includes("source")) acc.repo_url = url;
      if (label.includes("demo") || label.includes("live") || label.includes("video")) acc.demo_url = url;
      return acc;
    }, {});
  }
  if (typeof value === "object") return value;
  return {};
}

function normalizeTracks(value) {
  if (Array.isArray(value)) return value.map((track) => String(track).trim()).filter(Boolean);
  if (typeof value === "string") {
    const parsed = parseJsonArray(value, null);
    if (Array.isArray(parsed)) return parsed.map((track) => String(track).trim()).filter(Boolean);
    return value.split(/[|,]/).map((track) => track.trim()).filter(Boolean);
  }
  return [];
}

function firstPresent(...values) {
  for (const value of values) {
    const trimmed = stringOrNull(value);
    if (trimmed) return trimmed;
  }
  return null;
}

function stringifyJson(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ value });
    }
  }
  return JSON.stringify(value);
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeMemberRole(value) {
  const normalized = String(value || "member").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PROJECT_MEMBER_ROLES.has(normalized) ? normalized : "member";
}

function fileExtension(filename) {
  const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]{1,12})$/);
  return match ? match[1] : "";
}

function displayName(person = {}) {
  return stringOrNull(person?.name) || stringOrNull(`${person?.first_name || ""} ${person?.last_name || ""}`);
}

async function ensureProjectMediaUploadTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS project_media_uploads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      uploaded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES user_sessions(id) ON DELETE SET NULL,
      event_slug TEXT REFERENCES events(slug) ON DELETE SET NULL,
      event_instance_id TEXT REFERENCES event_instances(id) ON DELETE SET NULL,
      storage_key TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'artifact')),
      bytes INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_project_media_uploads_project_created
      ON project_media_uploads(project_id, created_at DESC)
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_project_media_uploads_uploader_created
      ON project_media_uploads(uploaded_by_user_id, created_at DESC)
  `).run();
}

export function maxProjectMediaBytes(env = {}) {
  const configured = Number(env.PROJECT_MEDIA_MAX_UPLOAD_BYTES || env.PROJECT_MEDIA_MAX_UPLOAD_MB && Number(env.PROJECT_MEDIA_MAX_UPLOAD_MB) * 1024 * 1024);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PROJECT_MEDIA_MAX_BYTES;
}

function maxProjectMediaFiles(env = {}) {
  const configured = Number(env.PROJECT_MEDIA_MAX_FILES || env.PROJECT_MEDIA_UPLOAD_LIMIT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_PROJECT_MEDIA_MAX_FILES;
}

function normalizeContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function validateAndBuildProjectMediaUpload({ project = {}, user = {}, sessionId = null, filename, kind, contentType, contentLength, env = {}, eventSlug = null, eventInstanceId = null, now = new Date() } = {}) {
  const safeFilename = sanitizeFilename(filename || "project-media");
  const type = normalizeContentType(contentType);
  const normalizedKind = normalizeProjectMediaKind(kind, type);
  const size = Number(contentLength || 0);
  const limit = maxProjectMediaBytes(env);
  const errors = [];

  if (!project?.id) errors.push("project is required");
  if (!user?.id) errors.push("signed-in user is required");
  if (!PROJECT_MEDIA_KINDS.has(normalizedKind)) errors.push("Upload kind must be image, video, or artifact.");
  if (!type) errors.push("Content-Type is required.");
  if (normalizedKind === "image" && !PROJECT_IMAGE_TYPES.has(type)) errors.push("Image uploads must be jpeg, png, webp, or gif.");
  if (normalizedKind === "video" && !PROJECT_VIDEO_TYPES.has(type)) errors.push("Video uploads must be mp4, mov, or webm.");
  if (normalizedKind === "artifact" && !PROJECT_ARTIFACT_TYPES.has(type)) errors.push("Artifact uploads must be PDF or ZIP files.");
  const extension = fileExtension(safeFilename);
  const allowedExtensions = PROJECT_MEDIA_EXTENSIONS[type];
  if (allowedExtensions && (!extension || !allowedExtensions.has(extension))) {
    errors.push(`${type} uploads must use one of these filename extensions: ${[...allowedExtensions].join(", ")}.`);
  }
  if (!size || size < 1) errors.push("Content-Length is required.");
  if (size && size > limit) errors.push(`File is too large. Limit is ${Math.round(limit / 1024 / 1024)}MB; paste a YouTube/Loom/Drive link for larger videos.`);

  if (errors.length) return { ok: false, errors, safeFilename, contentType: type, kind: normalizedKind, size };

  const uploadedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const id = randomId("pmu");
  const teamSlug = slugify(project.team_name || project.title || project.slug || project.id);
  const projectSlug = slugify(project.slug || project.title || project.id);
  const key = `submissions/${teamSlug}/project-media/${projectSlug}/${uploadedAt.replace(/[:.]/g, "-")}-${id}-${safeFilename}`;
  const cleanEventSlug = eventSlug && SLUG_RE.test(String(eventSlug)) ? String(eventSlug) : null;
  const cleanEventInstanceId = stringOrNull(eventInstanceId);
  const provenance = {
    uploaderUserId: user.id,
    uploaderEmail: user.email || null,
    sessionId: sessionId || null,
    projectId: project.id,
    projectSlug: project.slug || null,
    eventSlug: cleanEventSlug,
    eventInstanceId: cleanEventInstanceId,
    uploadedAt,
    key
  };
  return {
    ok: true,
    id,
    projectId: project.id,
    uploadedByUserId: user.id,
    sessionId: sessionId || null,
    eventSlug: cleanEventSlug,
    eventInstanceId: cleanEventInstanceId,
    key,
    kind: normalizedKind,
    filename: safeFilename,
    contentType: type,
    size,
    uploadedAt,
    provenance,
    metadata: {
      originalFilename: safeFilename,
      kind: normalizedKind,
      projectId: project.id,
      projectSlug: project.slug || null,
      eventSlug: cleanEventSlug || "",
      eventInstanceId: cleanEventInstanceId || "",
      uploadedByUserId: user.id,
      sessionId: sessionId || "",
      uploadedAt
    }
  };
}

function normalizeProjectMediaKind(kind, type) {
  const normalized = String(kind || "").trim().toLowerCase();
  if (PROJECT_MEDIA_KINDS.has(normalized)) return normalized;
  if (String(type || "").startsWith("image/")) return "image";
  if (String(type || "").startsWith("video/")) return "video";
  return "artifact";
}

async function findProjectByInputSlug(db, input = {}) {
  const { project, errors } = normalizeProjectInput(input);
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  return await db.prepare("SELECT * FROM projects WHERE slug = ?").bind(project.slug).first();
}

async function findProjectMembership(db, projectId, person = {}) {
  if (!projectId) return null;
  const personId = person?.id || person?.user_id || null;
  const email = normalizeEmail(person?.email);
  if (!personId && !email) return null;
  return await db.prepare(`
    SELECT *
    FROM project_members
    WHERE project_id = ? AND (user_id = ? OR lower(email) = lower(?))
    LIMIT 1
  `).bind(projectId, personId || "", email || "").first();
}

async function getUserById(db, userId) {
  if (!userId) return null;
  return await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
}
