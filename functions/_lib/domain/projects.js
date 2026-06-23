import { parseJsonArray, stringOrNull } from "./shared.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_MEMBER_ROLES = new Set(["owner", "member", "mentor", "judge", "admin"]);

export function normalizeProjectInput(input = {}, existing = {}) {
  const links = normalizeLinks(input.links);
  const title = firstPresent(input.title, input.project_title, input.projectTitle, existing.title);
  const slug = firstPresent(input.slug, existing.slug, slugify(title));
  const tracks = normalizeTracks(input.tracks ?? input.track ?? existing.tracks_json);
  const project = {
    slug,
    title,
    team_name: firstPresent(input.team_name, input.teamName, input.team, existing.team_name),
    description: firstPresent(input.description, input.summary, existing.description),
    repo_url: firstPresent(input.repo_url, input.repoLink, input.repository_url, input.repository, links.repo_url, links.repository, existing.repo_url),
    demo_url: firstPresent(input.demo_url, input.demoLink, input.demo, links.demo_url, links.demo, existing.demo_url),
    tracks_json: stringifyJson(tracks),
    canonical_submission_id: firstPresent(input.canonical_submission_id, input.submission_id, input.submissionId, existing.canonical_submission_id)
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

export async function upsertProject(db, input = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  const { project, errors } = normalizeProjectInput(input);
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

export async function updateProject(db, { projectId, actorPerson, patch = {}, now = new Date().toISOString() } = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  const existing = await getProjectForActor(db, projectId, actorPerson);
  const { project, errors } = normalizeProjectInput(patch, existing);
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

export async function updateOwnedProjectForUser(db, userId, projectId, input = {}) {
  if (!userId) throw Object.assign(new Error("userId is required"), { status: 400 });
  const user = await getUserById(db, userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  return await updateProject(db, { projectId, actorPerson: user, patch: input });
}

export async function getOwnedProject(db, userId, projectId) {
  if (!userId) throw Object.assign(new Error("userId is required"), { status: 400 });
  const user = await getUserById(db, userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  return await getProjectForActor(db, projectId, user);
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
    WHERE p.id = ? AND (pm.user_id = ? OR lower(pm.email) = lower(?))
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

function displayName(person = {}) {
  return stringOrNull(person?.name) || stringOrNull(`${person?.first_name || ""} ${person?.last_name || ""}`);
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
