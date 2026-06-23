import {
  getEventSeries as domainGetEventSeries,
  listEventInstances as domainListEventInstances,
  listEventSeries as domainListEventSeries,
  normalizeEventSeriesInput,
  parseSignupFieldConfig,
  previewGeneratedInstances,
  resolveOpenEventInstance,
  toEventInstance,
  toEventSeries
} from "./domain/events.js";
import {
  cancelParticipation,
  checkInParticipant,
  listParticipationRoster as domainListParticipationRoster,
  normalizeParticipationInput,
  registerParticipation,
  resolveParticipationReadiness
} from "./domain/participation.js";
import {
  applySafetyProfileToMetadata,
  normalizePersonSafetyProfile,
  personSafetyReadiness,
  safetyProfileFromPerson,
  safetyProfileInputFromPatch,
  snapshotPersonSafetyForEvent,
  updatePersonSafetyProfile
} from "./domain/people.js";
import {
  decorateBadge,
  dedupeBadges,
  deriveBadgesFromFacts,
  listPersonBadges
} from "./domain/badges.js";

export {
  EventInstanceSchema,
  EventSeriesSchema,
  RecurrenceRuleSchema,
  SignupFieldConfigSchema,
  getEventSeries,
  listEventSeries,
  normalizeEventInstanceInput,
  normalizeEventSeriesInput,
  parseSignupFieldConfig,
  previewGeneratedInstances,
  resolveOpenEventInstance,
  toEventInstance,
  toEventSeries
} from "./domain/events.js";

export {
  cancelParticipation,
  checkInParticipant,
  listParticipationRoster,
  normalizeParticipationInput,
  registerParticipation,
  resolveParticipationReadiness
} from "./domain/participation.js";

export {
  normalizePersonSafetyProfile,
  personSafetyReadiness,
  safetyProfileFromPerson,
  snapshotPersonSafetyForEvent,
  updatePersonSafetyProfile
} from "./domain/people.js";

export {
  awardBadge,
  badgeIconUrl,
  dedupeBadges,
  decorateBadge,
  defaultBadgeForSlug,
  deriveBadgesForPerson,
  deriveBadgesFromFacts,
  ensureBadge,
  listBadgeCatalog,
  listPersonBadges,
  revokeBadgeAward
} from "./domain/badges.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPEN_STATUSES = new Set(["draft", "open", "closed", "archived"]);
const HELPER_INTEREST_ROLES = new Set(["volunteer", "mentor", "judge", "workshop_host", "sponsor", "organizer", "other"]);

export function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers || {}) }
  });
}

export function methodNotAllowed(methods) {
  return jsonResponse({ error: `Method not allowed. Use ${methods.join(", ")}.` }, {
    status: 405,
    headers: { Allow: methods.join(", ") }
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!match) return "";
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return match.slice(name.length + 1);
  }
}

function adminBootstrapTokenEnabled(env = {}) {
  return [env.HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED, env.HTV_ADMIN_TOKEN_BOOTSTRAP]
    .some((value) => String(value || "").trim() === "1");
}

function adminTokenFromRequest(request) {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerToken = request.headers.get("X-Admin-Token") || "";
  return bearer || headerToken;
}

function bootstrapTokenMatches(request, env = {}) {
  const configuredToken = env.HTV_ADMIN_TOKEN || env.ADMIN_TOKEN;
  return Boolean(configuredToken && adminTokenFromRequest(request) === configuredToken);
}

async function findActiveRole(db, userId, allowedRoles, { scopeType = "global", scopeId = "*" } = {}) {
  const roles = [...new Set(allowedRoles)].filter(Boolean);
  if (!userId || !roles.length) return null;
  const placeholders = roles.map(() => "?").join(", ");
  const binds = [userId, ...roles];
  const scopeClauses = ["(scope_type = 'global' AND scope_id = '*')"];
  if (scopeType && scopeId) {
    scopeClauses.push("(scope_type = ? AND scope_id = ?)");
    binds.push(scopeType, scopeId);
  }
  return await db.prepare(`
    SELECT role, scope_type, scope_id, created_at
    FROM roles
    WHERE user_id = ?
      AND revoked_at IS NULL
      AND role IN (${placeholders})
      AND (${scopeClauses.join(" OR ")})
    ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at ASC
    LIMIT 1
  `).bind(...binds).first();
}

async function requireRoleAccess(request, env, allowedRoles, scope = {}) {
  const db = getDb(env);
  const sessionToken = cookieValue(request, "htv_session") || request.headers.get("x-htv-session") || "";
  const user = await getCurrentUserFromSession(db, sessionToken);
  const role = user ? await findActiveRole(db, user.id, allowedRoles, scope) : null;
  if (role) return { user, role, bootstrap: false };

  if (adminBootstrapTokenEnabled(env) && bootstrapTokenMatches(request, env)) {
    return { user: null, role: { role: "bootstrap", scope_type: "global", scope_id: "*" }, bootstrap: true };
  }

  const error = new Error(user ? "Forbidden" : "Unauthorized");
  error.status = user ? 403 : 401;
  throw error;
}

export async function requireAdmin(request, env, scope = {}) {
  return await requireRoleAccess(request, env, ["super_admin", "admin"], scope);
}

export async function requireOrganizerAccess(request, env, scope = {}) {
  return await requireRoleAccess(request, env, ["super_admin", "admin"], scope);
}

export async function requireSuperAdminAccess(request, env, scope = {}) {
  return await requireRoleAccess(request, env, ["super_admin"], scope);
}

export async function getCurrentUserFromRequest(db, request) {
  const token = cookieValue(request, "htv_session") || request.headers.get("x-htv-session") || "";
  return await getCurrentUserFromSession(db, token);
}

export function getDb(env) {
  const db = env.HTV_DB || env.SUBMISSIONS_DB || env.DB;
  if (!db) {
    throw Object.assign(new Error("HTV_DB D1 binding is not configured"), { status: 500 });
  }
  return db;
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

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function normalizeEventInput(input, existing = {}) {
  return normalizeEventSeriesInput(input, existing);
}

export function normalizeEmergencyContactInput(input = {}) {
  const nested = input.emergency_contact && typeof input.emergency_contact === "object" ? input.emergency_contact : {};
  const contact = {
    name: trimOrNull(input.emergency_contact_name ?? nested.name),
    phone: trimOrNull(input.emergency_contact_phone ?? nested.phone),
    relationship: trimOrNull(input.emergency_contact_relationship ?? nested.relationship)
  };
  const errors = [];
  if (!contact.name) errors.push("emergency contact name is required");
  if (!contact.phone) errors.push("emergency contact phone is required");
  const phoneDigits = String(contact.phone || "").replace(/\D/g, "");
  if (contact.phone && phoneDigits.length < 7) errors.push("emergency contact phone must include at least 7 digits");
  return { contact, errors };
}

export function normalizeHelperInterestInput(input = {}, currentUser = null) {
  const nested = input.helper_interest && typeof input.helper_interest === "object" ? input.helper_interest : {};
  const email = normalizeEmail(input.email ?? nested.email ?? currentUser?.email);
  const suppliedName = trimOrNull(input.name ?? nested.name);
  const name = suppliedName || trimOrNull(currentUser?.name) || trimOrNull(`${currentUser?.first_name || ""} ${currentUser?.last_name || ""}`) || null;
  const contact = trimOrNull(input.contact ?? input.contact_method ?? nested.contact ?? nested.contact_method ?? input.phone ?? currentUser?.phone);
  const roleInterest = String(input.role_interest ?? input.roleInterest ?? nested.role_interest ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const consentRaw = input.consent_contact ?? input.consentToContact ?? nested.consent_contact;
  const consentContact = consentRaw === true || consentRaw === 1 || ["1", "true", "yes", "on"].includes(String(consentRaw || "").toLowerCase());
  const metadata = input.metadata ?? nested.metadata ?? null;

  const helperInterest = {
    user_id: currentUser?.id || trimOrNull(input.user_id ?? nested.user_id),
    name,
    email: email || null,
    contact,
    role_interest: roleInterest,
    availability: trimOrNull(input.availability ?? nested.availability),
    event_interest: trimOrNull(input.event_interest ?? input.eventInterest ?? nested.event_interest),
    skills: trimOrNull(input.skills ?? nested.skills),
    notes: trimOrNull(input.notes ?? input.message ?? nested.notes),
    consent_contact: consentContact ? 1 : 0,
    source: trimOrNull(input.source ?? nested.source) || "helper-interest-form",
    status: trimOrNull(input.status ?? nested.status) || "new",
    metadata_json: stringifyJson(metadata)
  };

  const errors = [];
  if (!helperInterest.name) errors.push("name is required");
  if (helperInterest.email && !EMAIL_RE.test(helperInterest.email)) errors.push("valid email is required when email is provided");
  if (!helperInterest.email && !helperInterest.contact) errors.push("email or contact method is required");
  if (!HELPER_INTEREST_ROLES.has(helperInterest.role_interest)) {
    errors.push("role interest must be volunteer, mentor, judge, workshop host, sponsor, organizer, or other");
  }
  if (!helperInterest.consent_contact) errors.push("consent to be contacted is required");

  return { helperInterest, errors };
}

export function normalizeSignupInput(input, eventSlug, { requireEmergencyContact = true, currentUser = null } = {}) {
  const email = normalizeEmail(input.email) || normalizeEmail(currentUser?.email);
  const suppliedName = String(input.name || `${input.first_name || ""} ${input.last_name || ""}`).trim();
  const currentUserName = trimOrNull(currentUser?.name) || trimOrNull(`${currentUser?.first_name || ""} ${currentUser?.last_name || ""}`);
  const name = suppliedName || currentUserName || email;
  const nameParts = splitName(name);
  const firstName = String(input.first_name || nameParts.firstName).trim();
  const lastName = String(input.last_name || nameParts.lastName).trim();
  const wantsEmailList = input.email_list_opt_in !== false;
  const emergency = normalizeEmergencyContactInput(input);

  const signup = {
    event_slug: eventSlug,
    email,
    name,
    first_name: firstName,
    last_name: lastName,
    phone: trimOrNull(input.phone) || trimOrNull(currentUser?.phone),
    school: trimOrNull(input.school ?? input.university) || trimOrNull(currentUser?.school),
    year: trimOrNull(input.year),
    experience: trimOrNull(input.experience),
    notes: trimOrNull(input.notes || input.message),
    email_list_opt_in: wantsEmailList ? 1 : 0,
    metadata_json: stringifyJson(normalizeSignupMetadata(input)),
    emergency_contact: emergency.contact
  };

  const errors = [];
  if (!signup.event_slug) errors.push("event slug is required");
  if (!signup.name) errors.push("name is required");
  if (!EMAIL_RE.test(email)) errors.push("valid email is required");
  if (requireEmergencyContact) errors.push(...emergency.errors);

  return { signup, errors };
}

function buildLegacyMetadata(input) {
  const metadata = {};
  for (const key of ["major", "dietary", "tshirt", "coc", "source", "referrer"]) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") metadata[key] = input[key];
  }
  return metadata;
}

export function generateId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function trimOrNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
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
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArray(value, fallback = []) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeSignupRoleValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  return normalized || null;
}

export function signupRolesForEvent(event = {}) {
  return signupRoleConfigForEvent(event).roles;
}

function signupRoleConfigForEvent(event = {}) {
  try {
    const config = parseSignupFieldConfig(event);
    return {
      roles: config.roles || [],
      default_role: config.default_role || null,
      label: config.label || "How do you want to participate?"
    };
  } catch {
    return legacySignupRoleConfigForEvent(event);
  }
}

function legacySignupRoleConfigForEvent(event = {}) {
  const config = parseJsonObject(event.signup_fields_json, {});
  const rawRoles = Array.isArray(config.roles)
    ? config.roles
    : Array.isArray(config.signup_roles)
      ? config.signup_roles
      : [];
  const roles = rawRoles
    .map((role) => {
      const source = role && typeof role === "object" ? role : { value: role, label: role };
      const value = normalizeSignupRoleValue(source.value || source.id || source.key || source.label);
      if (!value) return null;
      return {
        value,
        label: trimOrNull(source.label) || value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
        description: trimOrNull(source.description || source.help || source.hint)
      };
    })
    .filter(Boolean);
  const requestedDefault = normalizeSignupRoleValue(config.default_role || config.defaultRole);
  return {
    roles,
    default_role: roles.find((role) => role.value === requestedDefault)?.value || roles[0]?.value || null,
    label: trimOrNull(config.role_label || config.signup_role_label) || "How do you want to participate?"
  };
}

export function applySignupRole(input = {}, event = {}) {
  const config = signupRoleConfigForEvent(event);
  const supplied = normalizeSignupRoleValue(input.signup_role ?? input.role ?? input.signupRole);
  const role = supplied || config.default_role;
  const errors = [];
  if (config.roles.length && (!role || !config.roles.some((candidate) => candidate.value === role))) {
    errors.push(`signup role must be one of: ${config.roles.map((candidate) => candidate.value).join(", ")}`);
  }
  return { input: role ? { ...input, signup_role: role } : input, signup_role: role || null, roles: config.roles, errors };
}

function normalizeSignupMetadata(input = {}) {
  const metadata = { ...parseJsonObject(input.metadata, {}) };
  const legacy = buildLegacyMetadata(input);
  for (const [key, value] of Object.entries(legacy)) {
    if (metadata[key] === undefined) metadata[key] = value;
  }
  const signupRole = normalizeSignupRoleValue(input.signup_role ?? input.role ?? input.signupRole ?? metadata.signup_role ?? metadata.role);
  if (signupRole) metadata.signup_role = signupRole;
  return metadata;
}

function normalizeTracks(value) {
  if (Array.isArray(value)) return value.map((track) => String(track).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[|,]/).map((track) => track.trim()).filter(Boolean);
  return [];
}

function firstPresent(...values) {
  for (const value of values) {
    const trimmed = trimOrNull(value);
    if (trimmed) return trimmed;
  }
  return null;
}

export function normalizeProjectInput(input = {}, existing = {}) {
  const title = firstPresent(input.title, input.project_title, input.projectTitle, existing.title);
  const slug = firstPresent(input.slug, existing.slug, slugify(title));
  const tracks = normalizeTracks(input.tracks ?? input.track ?? existing.tracks_json);
  const project = {
    slug,
    title,
    team_name: firstPresent(input.team_name, input.teamName, input.team, existing.team_name),
    description: firstPresent(input.description, input.summary, existing.description),
    repo_url: firstPresent(input.repo_url, input.repoLink, input.repository_url, input.repository, existing.repo_url),
    demo_url: firstPresent(input.demo_url, input.demoLink, input.demo, existing.demo_url),
    tracks_json: stringifyJson(tracks),
    canonical_submission_id: firstPresent(input.canonical_submission_id, input.submission_id, existing.canonical_submission_id)
  };
  const errors = [];
  if (!project.title) errors.push("project title is required");
  if (!project.slug || !SLUG_RE.test(project.slug)) errors.push("project slug must use lowercase letters, numbers, and hyphens");
  return { project, errors };
}

function sanitizeProjectRow(row = {}) {
  const { contact_email, payload_json, uploads_json, ...safe } = row;
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

function normalizeAwards(value) {
  return parseJsonArray(value).map((award) => ({
    slug: award.award_slug || award.slug || slugify(award.award_title || award.title || "award"),
    title: award.award_title || award.title || "Award",
    rank: Number(award.award_rank || award.rank || 1),
    prize_amount_cents: award.prize_amount_cents ?? null
  })).filter((award) => award.title);
}

function isPublicProjectMedia(upload = {}) {
  const key = String(upload.key || "");
  const contentType = String(upload.contentType || upload.content_type || "").toLowerCase();
  const kind = String(upload.kind || "").toLowerCase();
  return key.startsWith("submissions/") && (kind === "image" || kind === "video" || contentType.startsWith("image/") || contentType.startsWith("video/"));
}

function firstPublicProjectMedia(uploadsJson) {
  return parseJsonArray(uploadsJson).find(isPublicProjectMedia) || null;
}

function publicProjectHeroMedia(row = {}) {
  const media = firstPublicProjectMedia(row.hero_uploads_json);
  if (!media || !row.event_slug || !row.slug) return null;
  const contentType = media.contentType || media.content_type || "application/octet-stream";
  const kind = String(media.kind || "").toLowerCase() || (String(contentType).startsWith("video/") ? "video" : "image");
  return {
    kind,
    content_type: contentType,
    filename: media.filename || media.originalFilename || "Project media",
    url: `/api/projects/media?event=${encodeURIComponent(row.event_slug)}&project=${encodeURIComponent(row.slug)}`,
    alt: `${row.title || "Project"} ${kind === "video" ? "video" : "image"}`
  };
}

function sanitizePublicProjectRow(row = {}) {
  return {
    id: row.project_id || row.id,
    slug: row.slug,
    title: row.title,
    team_name: row.team_name,
    description: row.description,
    repo_url: row.repo_url || null,
    demo_url: row.demo_url || null,
    tracks: parseJsonArray(row.tracks_json, normalizeTracks(row.tracks_json)),
    event_slug: row.event_slug || null,
    status: row.status || "showcased",
    awards: normalizeAwards(row.awards_json),
    hero_media: publicProjectHeroMedia(row),
    submitted_at: row.submission_created_at || row.created_at || null,
    updated_at: row.updated_at || null
  };
}

export async function upsertProject(db, input = {}) {
  const { project, errors } = normalizeProjectInput(input);
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  const now = new Date().toISOString();
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
  return await db.prepare("SELECT * FROM projects WHERE slug = ?").bind(project.slug).first();
}

export async function claimProjectForUser(db, userId, input = {}) {
  if (!userId) throw Object.assign(new Error("userId is required"), { status: 400 });
  const project = await upsertProject(db, input);
  const user = await getUserById(db, userId);
  const now = new Date().toISOString();
  const role = input.role || "owner";
  const source = input.source || "participant_dashboard";
  const id = `prm_${project.id}_${userId}`.replace(/[^a-zA-Z0-9_]+/g, "_");
  await db.prepare(`
    INSERT INTO project_members (
      id, project_id, user_id, name, email, role, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET
      role = CASE WHEN project_members.role = 'owner' THEN project_members.role ELSE excluded.role END,
      source = excluded.source
  `).bind(id, project.id, userId, user?.name || input.name || null, user?.email || input.email || null, role, source, now).run();
  const membership = await db.prepare("SELECT * FROM project_members WHERE project_id = ? AND user_id = ?").bind(project.id, userId).first();
  return {
    project: sanitizeProjectRow(project),
    membership: membership || { id, project_id: project.id, user_id: userId, role, source, created_at: now }
  };
}

async function getOwnedProject(db, userId, projectId) {
  if (!userId) throw Object.assign(new Error("userId is required"), { status: 400 });
  if (!projectId) throw Object.assign(new Error("project_id is required"), { status: 400 });
  const user = await getUserById(db, userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  const project = await db.prepare(`
    SELECT p.*
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id
    WHERE p.id = ? AND (pm.user_id = ? OR lower(pm.email) = lower(?))
    LIMIT 1
  `).bind(projectId, userId, user.email || "").first();
  if (!project) throw Object.assign(new Error("Project not found for signed-in user"), { status: 404 });
  await db.prepare(`
    UPDATE project_members
    SET user_id = COALESCE(user_id, ?)
    WHERE project_id = ? AND user_id IS NULL AND lower(email) = lower(?)
  `).bind(userId, projectId, user.email || "").run();
  return project;
}

export async function updateOwnedProjectForUser(db, userId, projectId, input = {}) {
  const existing = await getOwnedProject(db, userId, projectId);
  const { project, errors } = normalizeProjectInput(input, existing);
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  const now = new Date().toISOString();
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

export async function submitOwnedProjectToEvent(db, userId, projectId, input = {}) {
  const project = await getOwnedProject(db, userId, projectId);
  const eventSlug = input.event_slug || input.eventSlug;
  if (!eventSlug) throw Object.assign(new Error("event_slug is required"), { status: 400 });
  const explicitInstanceId = input.event_instance_id || input.eventInstanceId || null;
  const hiddenSubmission = await db.prepare(`
    SELECT id, status
    FROM event_project_submissions
    WHERE event_slug = ? AND project_id = ? AND status = 'hidden'
    LIMIT 1
  `).bind(eventSlug, project.id).first();
  if (hiddenSubmission) {
    throw Object.assign(new Error("This project submission was hidden by an organizer. Ask an organizer to restore it before submitting again."), { status: 409 });
  }
  const eventInstance = explicitInstanceId ? null : await resolveSignupEventInstance(db, eventSlug);
  const submission = await linkProjectSubmission(db, {
    eventSlug,
    eventInstanceId: explicitInstanceId || eventInstance?.id || null,
    projectId: project.id,
    submissionId: input.submission_id || input.submissionId || project.canonical_submission_id || null,
    status: input.status || "submitted",
    source: "participant_dashboard"
  });
  return { project: sanitizeProjectRow(project), submission };
}

export async function updateEventProjectSubmissionStatus(db, { eventSlug, projectId, status = "hidden" } = {}) {
  if (!eventSlug) throw Object.assign(new Error("eventSlug is required"), { status: 400 });
  if (!projectId) throw Object.assign(new Error("projectId is required"), { status: 400 });
  const allowed = new Set(["submitted", "accepted", "showcased", "winner", "rejected", "hidden"]);
  const normalizedStatus = String(status || "hidden").trim().toLowerCase();
  if (!allowed.has(normalizedStatus)) throw Object.assign(new Error("Unsupported project submission status"), { status: 400 });
  const existing = await db.prepare(`
    SELECT eps.*, p.title, p.team_name
    FROM event_project_submissions eps
    JOIN projects p ON p.id = eps.project_id
    WHERE eps.event_slug = ? AND eps.project_id = ?
    LIMIT 1
  `).bind(eventSlug, projectId).first();
  if (!existing) throw Object.assign(new Error("Event project submission not found"), { status: 404 });
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE event_project_submissions
    SET status = ?, updated_at = ?
    WHERE event_slug = ? AND project_id = ?
  `).bind(normalizedStatus, now, eventSlug, projectId).run();
  return {
    ...existing,
    status: normalizedStatus,
    updated_at: now
  };
}

export async function linkProjectSubmission(db, { eventSlug, eventInstanceId = null, projectId, submissionId = null, status = "submitted", source = "submission_portal" } = {}) {
  if (!eventSlug) throw Object.assign(new Error("eventSlug is required"), { status: 400 });
  if (!projectId) throw Object.assign(new Error("projectId is required"), { status: 400 });
  const now = new Date().toISOString();
  const id = `eps_${eventSlug}_${eventInstanceId || "event"}_${projectId}_${submissionId || "manual"}`.replace(/[^a-zA-Z0-9_]+/g, "_");
  await db.prepare(`
    INSERT INTO event_project_submissions (
      id, event_slug, event_instance_id, project_id, submission_id, status, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).bind(id, eventSlug, eventInstanceId, projectId, submissionId, status, source, now, now).run();
  return { id, event_slug: eventSlug, event_instance_id: eventInstanceId, project_id: projectId, submission_id: submissionId, status, source };
}

export async function upsertProjectFromSubmission(db, submissionId, { eventSlug = "hack-the-valley-2026", eventInstanceId = null, status = "submitted" } = {}) {
  const submission = await db.prepare("SELECT * FROM submissions WHERE id = ?").bind(submissionId).first();
  if (!submission) throw Object.assign(new Error("Submission not found"), { status: 404 });
  const payload = parseJsonObject(submission.payload_json, {});
  const project = await upsertProject(db, {
    title: submission.project_title,
    team_name: submission.team_name,
    description: payload.description,
    repo_url: payload.repoLink || payload.repo_url || payload.repository,
    demo_url: payload.demoLink || payload.demo_url || payload.demo,
    tracks: payload.tracks || submission.track,
    canonical_submission_id: submission.id
  });
  await linkProjectSubmission(db, { eventSlug, eventInstanceId, projectId: project.id, submissionId: submission.id, status });
  return project;
}

export async function listEventProjectSubmissions(db, eventSlug, eventInstanceId = null, { includeHidden = false } = {}) {
  const statusFilter = includeHidden ? "" : "AND eps.status != 'hidden'";
  const instanceFilter = eventInstanceId ? "AND eps.event_instance_id = ?" : "";
  const args = eventInstanceId ? [eventSlug, eventInstanceId] : [eventSlug];
  const result = await db.prepare(`
    SELECT
      eps.event_slug,
      eps.event_instance_id,
      eps.status,
      eps.source,
      eps.created_at,
      p.id AS project_id,
      p.slug,
      p.title,
      p.team_name,
      p.description,
      p.repo_url,
      p.demo_url,
      p.tracks_json,
      s.id AS submission_id
    FROM event_project_submissions eps
    JOIN projects p ON p.id = eps.project_id
    LEFT JOIN submissions s ON s.id = eps.submission_id
    WHERE eps.event_slug = ? ${instanceFilter} ${statusFilter}
    ORDER BY lower(p.title) ASC
  `).bind(...args).all();
  return (result.results || []).map(sanitizeProjectRow);
}

export async function listPublicProjects(db, { eventSlug = null, includeHidden = false } = {}) {
  const filters = [];
  const args = [];
  if (eventSlug) {
    filters.push("eps.event_slug = ?");
    args.push(eventSlug);
  }
  if (!includeHidden) {
    filters.push("eps.status NOT IN ('hidden', 'rejected')");
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await db.prepare(`
    SELECT
      eps.event_slug,
      eps.status,
      MAX(eps.updated_at) AS updated_at,
      p.id AS project_id,
      p.slug,
      p.title,
      p.team_name,
      p.description,
      p.repo_url,
      p.demo_url,
      p.tracks_json,
      MIN(s.created_at) AS submission_created_at,
      (
        SELECT s2.uploads_json
        FROM event_project_submissions eps2
        JOIN submissions s2 ON s2.id = eps2.submission_id
        WHERE eps2.event_slug = eps.event_slug
          AND eps2.project_id = p.id
          AND s2.uploads_json IS NOT NULL
          AND s2.uploads_json != '[]'
        ORDER BY s2.created_at ASC
        LIMIT 1
      ) AS hero_uploads_json,
      COALESCE(
        json_group_array(
          CASE WHEN epa.id IS NOT NULL THEN json_object(
            'award_slug', epa.award_slug,
            'award_title', epa.award_title,
            'award_rank', epa.award_rank,
            'prize_amount_cents', epa.prize_amount_cents
          ) END
        ) FILTER (WHERE epa.id IS NOT NULL),
        '[]'
      ) AS awards_json
    FROM event_project_submissions eps
    JOIN projects p ON p.id = eps.project_id
    LEFT JOIN submissions s ON s.id = eps.submission_id
    LEFT JOIN event_project_awards epa ON epa.event_slug = eps.event_slug AND epa.project_id = p.id
    ${where}
    GROUP BY eps.event_slug, eps.status, p.id, p.slug, p.title, p.team_name, p.description, p.repo_url, p.demo_url, p.tracks_json
    ORDER BY CASE WHEN COUNT(epa.id) > 0 THEN 0 ELSE 1 END, lower(p.title) ASC
  `).bind(...args).all();
  return (result.results || []).map(sanitizePublicProjectRow);
}

function leaderboardScore(row = {}) {
  return (Number(row.attended_htv_2026) > 0 ? 3 : 0)
    + (Number(row.project_count) > 0 ? 5 : 0)
    + (Number(row.hack_hours_checkins) || 0) * 2
    + (Number(row.prize_awards) > 0 ? 10 : 0)
    + (Number(row.overall_winner) > 0 ? 20 : 0);
}

function derivedLeaderboardBadges(row = {}) {
  const badges = [];
  if (Number(row.attended_htv_2026) > 0) badges.push(decorateBadge({ slug: "attended-htv-2026" }));
  if (Number(row.hack_hours_checkins) > 0) badges.push(decorateBadge({ slug: "attended-hack-hours" }));
  if (Number(row.project_count) > 0) badges.push(decorateBadge({ slug: "submitted-project" }));
  if (Number(row.prize_awards) > 0) badges.push(decorateBadge({ slug: "won-prize-htv-2026" }));
  if (Number(row.overall_winner) > 0) badges.push(decorateBadge({ slug: "won-overall-htv-2026" }));
  return badges;
}

function safeLeaderboardProject(row = {}) {
  return {
    slug: row.slug,
    title: row.title,
    team_name: row.team_name || null,
    event_slug: row.event_slug || null,
    submitted_at: row.submitted_at || null
  };
}

function publicLeaderboardDisplayName(value) {
  const cleaned = String(value || "").trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned === "Community member") return "Community member";
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const last = parts[parts.length - 1].replace(/[^\p{L}\p{N}]/gu, "");
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

export async function listCommunityLeaderboard(db, { limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const result = await db.prepare(`
    WITH facts AS (
      SELECT
        u.id AS user_id,
        COALESCE(
          NULLIF(TRIM(u.name), ''),
          NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''),
          'Community member'
        ) AS display_name,
        COUNT(DISTINCT CASE WHEN eps.id IS NOT NULL THEN p.id END) AS project_count,
        COUNT(DISTINCT CASE WHEN epe.event_slug = 'hack-hours' AND epe.event_type = 'checked_in' THEN epe.id END) AS hack_hours_checkins,
        MAX(CASE WHEN epe.event_slug = 'hack-the-valley-2026' AND epe.event_type = 'checked_in' THEN 1 ELSE 0 END) AS attended_htv_2026,
        COUNT(DISTINCT epa.id) AS prize_awards,
        MAX(CASE WHEN epa.award_slug = 'overall' OR lower(epa.award_title) LIKE '%overall%' THEN 1 ELSE 0 END) AS overall_winner
      FROM users u
      LEFT JOIN project_members pm ON pm.user_id = u.id OR (pm.email IS NOT NULL AND lower(pm.email) = lower(u.email))
      LEFT JOIN projects p ON p.id = pm.project_id
      LEFT JOIN event_project_submissions eps ON eps.project_id = p.id AND eps.status NOT IN ('hidden', 'rejected')
      LEFT JOIN event_project_awards epa ON epa.project_id = p.id AND epa.event_slug = 'hack-the-valley-2026' AND eps.event_slug = epa.event_slug
      LEFT JOIN event_participant_events epe ON epe.user_id = u.id
      GROUP BY u.id, u.name, u.first_name, u.last_name
    ), ranked AS (
      SELECT
        *,
        ((CASE WHEN attended_htv_2026 > 0 THEN 3 ELSE 0 END)
          + (CASE WHEN project_count > 0 THEN 5 ELSE 0 END)
          + (hack_hours_checkins * 2)
          + (CASE WHEN prize_awards > 0 THEN 10 ELSE 0 END)
          + (CASE WHEN overall_winner > 0 THEN 20 ELSE 0 END)) AS score
      FROM facts
      WHERE project_count > 0
        OR prize_awards > 0
        OR overall_winner > 0
    )
    SELECT *
    FROM ranked
    ORDER BY score DESC, (project_count + hack_hours_checkins + prize_awards + overall_winner + attended_htv_2026) DESC, lower(display_name) ASC
    LIMIT ?
  `).bind(safeLimit).all();

  const rows = result.results || [];
  const userIds = rows.map((row) => row.user_id).filter(Boolean);
  const projectsByUser = new Map();

  if (userIds.length) {
    const placeholders = userIds.map(() => "?").join(", ");
    const projects = await db.prepare(`
      SELECT DISTINCT u.id AS user_id, p.id AS project_id, p.slug, p.title, p.team_name, eps.event_slug, MIN(eps.created_at) AS submitted_at
      FROM users u
      JOIN project_members pm ON pm.user_id = u.id OR (pm.email IS NOT NULL AND lower(pm.email) = lower(u.email))
      JOIN projects p ON p.id = pm.project_id
      JOIN event_project_submissions eps ON eps.project_id = p.id AND eps.status NOT IN ('hidden', 'rejected')
      WHERE u.id IN (${placeholders})
      GROUP BY u.id, p.id, p.slug, p.title, p.team_name, eps.event_slug
      ORDER BY lower(p.title) ASC
    `).bind(...userIds).all();

    for (const project of projects.results || []) {
      const list = projectsByUser.get(project.user_id) || [];
      if (list.length < 3) list.push(safeLeaderboardProject(project));
      projectsByUser.set(project.user_id, list);
    }
  }

  return rows.map((row, index) => {
    const badges = dedupeBadges(derivedLeaderboardBadges(row)).map(({ slug, name, description, badge_type, icon_url }) => ({
      slug,
      name,
      description,
      badge_type,
      icon_url
    }));
    return {
      rank: index + 1,
      display_name: publicLeaderboardDisplayName(row.display_name),
      score: Number(row.score) || leaderboardScore(row),
      badge_count: badges.length,
      badges,
      metrics: {
        projects: Number(row.project_count) || 0,
        hack_hours_checkins: Number(row.hack_hours_checkins) || 0,
        attended_htv_2026: Number(row.attended_htv_2026) > 0,
        htv_2026_prize_awards: Number(row.prize_awards) || 0,
        htv_2026_overall_winner: Number(row.overall_winner) > 0
      },
      projects: projectsByUser.get(row.user_id) || []
    };
  });
}

export async function getPublicProjectHeroMedia(db, { eventSlug, projectSlug } = {}) {
  if (!eventSlug) throw Object.assign(new Error("event is required"), { status: 400 });
  if (!projectSlug) throw Object.assign(new Error("project is required"), { status: 400 });
  const result = await db.prepare(`
    SELECT s.uploads_json
    FROM event_project_submissions eps
    JOIN projects p ON p.id = eps.project_id
    JOIN submissions s ON s.id = eps.submission_id
    WHERE eps.event_slug = ?
      AND p.slug = ?
      AND eps.status NOT IN ('hidden', 'rejected')
      AND s.uploads_json IS NOT NULL
      AND s.uploads_json != '[]'
    ORDER BY s.created_at ASC
  `).bind(eventSlug, projectSlug).all();
  for (const row of result.results || []) {
    const media = firstPublicProjectMedia(row.uploads_json);
    if (media) return media;
  }
  return null;
}

export async function getUserCommunityState(db, userId) {
  const user = await getUserById(db, userId);
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  const [roles, attendance, badges, projects, projectAwards, emergencyContacts] = await Promise.all([
    db.prepare(`
      SELECT role, scope_type, scope_id, created_at, revoked_at
      FROM roles
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY role ASC
    `).bind(userId).all(),
    db.prepare(`
      SELECT event_slug, event_instance_id, signup_id, event_type, actor, source, occurred_at
      FROM event_participant_events
      WHERE user_id = ?
      ORDER BY occurred_at DESC
      LIMIT 100
    `).bind(userId).all(),
    listPersonBadges(db, userId),
    db.prepare(`
      SELECT p.id AS project_id, p.slug, p.title, p.team_name, p.description, p.repo_url, p.demo_url,
             p.canonical_submission_id, cs.payload_json, cs.uploads_json,
             eps.event_slug, eps.event_instance_id, eps.submission_id, COALESCE(eps.status, pm.role) AS status
      FROM project_members pm
      JOIN projects p ON p.id = pm.project_id
      LEFT JOIN submissions cs ON cs.id = p.canonical_submission_id
      LEFT JOIN event_project_submissions eps ON eps.project_id = p.id AND eps.status != 'hidden'
      WHERE (pm.user_id = ? OR lower(pm.email) = lower(?))
      ORDER BY lower(p.title) ASC
    `).bind(userId, user.email || "").all(),
    db.prepare(`
      SELECT DISTINCT epa.event_slug, epa.project_id, epa.award_slug, epa.award_title, epa.created_at AS awarded_at
      FROM project_members pm
      JOIN event_project_awards epa ON epa.project_id = pm.project_id
      WHERE epa.event_slug = 'hack-the-valley-2026'
        AND (pm.user_id = ? OR lower(pm.email) = lower(?))
      ORDER BY CASE WHEN epa.award_slug = 'overall' THEN 0 ELSE 1 END, epa.award_rank ASC, epa.award_title ASC
    `).bind(userId, user.email || "").all(),
    db.prepare(`
      SELECT
        s.event_slug,
        s.event_instance_id,
        s.id AS signup_id,
        e.title AS event_title,
        ei.instance_key,
        ei.title AS instance_title,
        ei.starts_at AS instance_starts_at,
        ec.id,
        ec.name,
        ec.relationship,
        ec.phone,
        ec.source,
        ec.updated_at,
        CASE WHEN ec.id IS NOT NULL AND length(trim(COALESCE(ec.name, ''))) > 0 AND length(trim(COALESCE(ec.phone, ''))) > 0 THEN 1 ELSE 0 END AS present
      FROM signups s
      JOIN events e ON e.slug = s.event_slug
      LEFT JOIN event_instances ei ON ei.id = s.event_instance_id
      LEFT JOIN emergency_contacts ec
        ON ec.event_instance_id = s.event_instance_id AND ec.user_id = s.user_id
      WHERE s.user_id = ?
      ORDER BY COALESCE(ei.starts_at, s.created_at) DESC, s.created_at DESC
    `).bind(userId).all()
  ]);
  const attendanceRows = attendance.results || [];
  const projectRows = (projects.results || []).map(sanitizeProjectRow);
  const storedBadges = badges || [];
  const derivedBadges = deriveBadgesFromFacts({ attendance: attendanceRows, projects: projectRows, projectAwards: projectAwards.results || [] });
  const safetyProfile = safetyProfileFromPerson(user);
  return {
    user: {
      ...user,
      safety_profile: safetyProfile.profile,
      safety_readiness: safetyProfile.readiness
    },
    person_safety_profile: safetyProfile.profile,
    person_safety_readiness: safetyProfile.readiness,
    roles: roles.results || [],
    attendance: attendanceRows,
    emergency_contacts: (emergencyContacts.results || []).map((row) => ({
      event_slug: row.event_slug,
      event_title: row.event_title,
      event_instance_id: row.event_instance_id,
      signup_id: row.signup_id,
      instance_key: row.instance_key,
      instance_title: row.instance_title,
      instance_starts_at: row.instance_starts_at,
      name: row.name || "",
      relationship: row.relationship || "",
      phone: row.phone || "",
      source: row.source || null,
      updated_at: row.updated_at || null,
      present: Boolean(row.present)
    })),
    badges: dedupeBadges([...storedBadges, ...derivedBadges]),
    projects: projectRows
  };
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomDigits(length = 6) {
  const array = new Uint32Array(length);
  globalThis.crypto.getRandomValues(array);
  return [...array].map((value) => String(value % 10)).join("");
}

function randomToken(prefix = "htvs") {
  const raw = new Uint8Array(24);
  globalThis.crypto.getRandomValues(raw);
  const token = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${prefix}_${token}`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function safeReturnPath(value, fallback = "/me/") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) return fallback;
  return path;
}

function publicBaseUrl(env = {}) {
  const configured = String(env.HTV_PUBLIC_BASE_URL || env.PUBLIC_BASE_URL || "https://hackthevalley.org").trim();
  try {
    const url = new URL(configured);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // fall through to production custom domain
  }
  return "https://hackthevalley.org";
}

function buildMagicLoginUrl({ token, next, env = {} }) {
  const url = new URL("/api/auth/magic-login", publicBaseUrl(env));
  url.searchParams.set("token", token);
  const returnPath = safeReturnPath(next, "/me/");
  if (returnPath) url.searchParams.set("next", returnPath);
  return url.toString();
}

async function createSessionForUser(db, user, input = {}, env = {}, now = new Date()) {
  const token = randomToken("htvs");
  const tokenHash = await sha256Hex(token);
  const sessionId = generateId("ses");
  const nowIso = now.toISOString();
  const expiresAt = addDays(now, Number(env.HTV_AUTH_SESSION_DAYS || 30));
  await db.prepare(`
    INSERT INTO user_sessions (
      id, user_id, token_hash, created_at, expires_at, revoked_at, user_agent, ip_hint
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).bind(sessionId, user.id, tokenHash, nowIso, expiresAt, input.user_agent || null, input.ip_hint || null).run();
  return {
    id: sessionId,
    token,
    expires_at: expiresAt
  };
}

async function sendLoginCodeWithResend({ email, name, code, magicLoginUrl, expiresAt, env = {}, fetcher = fetch }) {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  if (!apiKey) return null;
  const from = String(env.HTV_LOGIN_FROM_EMAIL || env.RESEND_LOGIN_FROM_EMAIL || env.RESEND_FROM_EMAIL || "Hack the Valley <updates@hackthevalley.org>").trim();
  const displayName = String(name || email).trim();
  const subject = "Your Hack the Valley login code and magic link";
  const text = [
    "Use this magic link to sign in to Hack the Valley:",
    magicLoginUrl,
    "",
    `Or enter this 6-digit code on the login page: ${code}.`,
    "",
    `It expires at ${expiresAt}.`,
    "If you did not request this, you can ignore this email."
  ].join("\n");
  const html = `
    <div style="font-family: Inter, Arial, sans-serif; color: #0f172a; line-height: 1.5;">
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Use this magic link to sign in to Hack the Valley:</p>
      <p style="margin: 24px 0;"><a href="${escapeHtml(magicLoginUrl)}" style="display: inline-block; background: #06b6d4; color: #0f172a; font-weight: 800; text-decoration: none; padding: 12px 18px; border-radius: 10px;">Sign in to Hack the Valley</a></p>
      <p>If the button does not work, copy and paste this link:</p>
      <p style="word-break: break-all;"><a href="${escapeHtml(magicLoginUrl)}">${escapeHtml(magicLoginUrl)}</a></p>
      <p>Or enter this 6-digit code on the login page:</p>
      <p style="font-size: 32px; font-weight: 800; letter-spacing: 0.24em; margin: 24px 0;">${escapeHtml(code)}</p>
      <p>This code expires at ${escapeHtml(expiresAt)}.</p>
      <p style="color: #64748b; font-size: 14px;">If you did not request this, you can ignore this email.</p>
    </div>
  `;
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject,
      text,
      html
    })
  });
  const bodyText = await safeText(response);
  if (!response.ok) {
    const error = new Error(`Resend login code send failed with HTTP ${response.status}: ${bodyText}`.slice(0, 500));
    error.status = 502;
    throw error;
  }
  let body = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = {}; }
  return { id: body.id || null };
}

export async function requestLoginCode(db, input = {}, env = {}, fetcher = fetch) {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw Object.assign(new Error("valid email is required"), { status: 400 });
  const user = await upsertUser(db, {
    email,
    name: input.name,
    first_name: input.first_name,
    last_name: input.last_name,
    phone: input.phone
  });
  const code = input.code && /^\d{6}$/.test(String(input.code)) ? String(input.code) : randomDigits(6);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = addMinutes(now, Number(env.HTV_AUTH_CODE_TTL_MINUTES || 15));
  const codeHash = await sha256Hex(`${user.id}:${email}:${code}`);
  const magicToken = randomToken("htvl");
  const magicTokenHash = await sha256Hex(magicToken);
  const magicLoginUrl = buildMagicLoginUrl({ token: magicToken, next: input.next, env });
  const id = generateId("alc");
  await db.prepare(`
    INSERT INTO auth_login_codes (
      id, user_id, email, code_hash, magic_token_hash, purpose, created_at, expires_at, consumed_at, attempt_count
    ) VALUES (?, ?, ?, ?, ?, 'login', ?, ?, NULL, 0)
  `).bind(id, user.id, email, codeHash, magicTokenHash, createdAt, expiresAt).run();
  const delivery = await sendLoginCodeWithResend({ email, name: user.name || input.name, code, magicLoginUrl, expiresAt, env, fetcher });
  const response = {
    ok: true,
    user_id: user.id,
    email,
    delivery: delivery ? "email_sent" : "not_configured",
    expires_at: expiresAt
  };
  if (delivery?.id) response.resend_email_id = delivery.id;
  if (env.HTV_AUTH_DEV_CODES === "1") response.dev_code = code;
  return response;
}

export async function verifyLoginCode(db, input = {}, env = {}) {
  const email = normalizeEmail(input.email);
  const code = String(input.code || "").trim();
  if (!EMAIL_RE.test(email)) throw Object.assign(new Error("valid email is required"), { status: 400 });
  if (!/^\d{6}$/.test(code)) throw Object.assign(new Error("six digit code is required"), { status: 400 });
  const user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user) throw Object.assign(new Error("Invalid or expired login code"), { status: 401 });
  const codeHash = await sha256Hex(`${user.id}:${email}:${code}`);
  const now = new Date();
  const nowIso = now.toISOString();
  const loginCode = await db.prepare(`
    SELECT *
    FROM auth_login_codes
    WHERE user_id = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(user.id, codeHash, nowIso).first();
  if (!loginCode) throw Object.assign(new Error("Invalid or expired login code"), { status: 401 });
  await db.prepare("UPDATE auth_login_codes SET consumed_at = ? WHERE id = ?").bind(nowIso, loginCode.id).run();
  const session = await createSessionForUser(db, user, input, env, now);
  return {
    ok: true,
    user,
    session
  };
}

export async function verifyLoginToken(db, input = {}, env = {}) {
  const magicToken = String(input.token || "").trim();
  if (!magicToken || magicToken.length < 24) {
    throw Object.assign(new Error("Invalid or expired login link"), { status: 401 });
  }
  const tokenHash = await sha256Hex(magicToken);
  const now = new Date();
  const nowIso = now.toISOString();
  const loginCode = await db.prepare(`
    SELECT
      alc.*,
      u.email AS user_email,
      u.name AS user_name,
      u.first_name AS user_first_name,
      u.last_name AS user_last_name,
      u.phone AS user_phone,
      u.created_at AS user_created_at,
      u.updated_at AS user_updated_at
    FROM auth_login_codes alc
    JOIN users u ON u.id = alc.user_id
    WHERE alc.magic_token_hash = ? AND alc.consumed_at IS NULL AND alc.expires_at > ?
    ORDER BY alc.created_at DESC
    LIMIT 1
  `).bind(tokenHash, nowIso).first();
  if (!loginCode) throw Object.assign(new Error("Invalid or expired login link"), { status: 401 });
  const user = {
    id: loginCode.user_id,
    email: loginCode.user_email || loginCode.email,
    name: loginCode.user_name || null,
    first_name: loginCode.user_first_name || null,
    last_name: loginCode.user_last_name || null,
    phone: loginCode.user_phone || null,
    created_at: loginCode.user_created_at || null,
    updated_at: loginCode.user_updated_at || null
  };
  await db.prepare("UPDATE auth_login_codes SET consumed_at = ? WHERE id = ?").bind(nowIso, loginCode.id).run();
  const session = await createSessionForUser(db, user, input, env, now);
  return {
    ok: true,
    user,
    session
  };
}

export async function getCurrentUserFromSession(db, token) {
  const sessionToken = String(token || "").trim();
  if (!sessionToken) return null;
  const tokenHash = await sha256Hex(sessionToken);
  const nowIso = new Date().toISOString();
  return await db.prepare(`
    SELECT
      u.*,
      us.id AS session_id,
      us.expires_at AS session_expires_at
    FROM user_sessions us
    JOIN users u ON u.id = us.user_id
    WHERE us.token_hash = ? AND us.revoked_at IS NULL AND us.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, nowIso).first();
}

export function sessionCookie(token, expiresAt) {
  const maxAge = Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return `htv_session=${encodeURIComponent(token)}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

export async function listEvents(db, { includeArchived = false } = {}) {
  return await domainListEventSeries(db, { includeArchived });
}

export async function getEvent(db, slug) {
  return await domainGetEventSeries(db, slug);
}

function instanceKeyFromStartsAt(value) {
  if (!value) return "unscheduled";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return slugify(value) || "unscheduled";
  return parsed.toISOString().slice(0, 10);
}

function instanceIdFor(eventSlug, instanceKey) {
  return `inst_${String(eventSlug).replaceAll("-", "_")}_${String(instanceKey).replaceAll("-", "_")}`;
}

export async function upsertEventInstance(db, event) {
  const instanceKey = instanceKeyFromStartsAt(event.starts_at);
  const instanceId = instanceIdFor(event.slug, instanceKey);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO event_instances (
      id, event_slug, instance_key, title, starts_at, ends_at, venue_name, venue_address, capacity, status,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_slug, instance_key) DO UPDATE SET
      title = excluded.title,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      venue_name = excluded.venue_name,
      venue_address = excluded.venue_address,
      capacity = excluded.capacity,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).bind(
    instanceId,
    event.slug,
    instanceKey,
    event.title,
    event.starts_at,
    event.ends_at,
    event.venue_name,
    event.venue_address,
    event.capacity,
    event.status,
    null,
    event.created_at || now,
    now
  ).run();
  return await db.prepare("SELECT * FROM event_instances WHERE id = ?").bind(instanceId).first();
}

export async function resolveSignupEventInstance(db, eventSlug) {
  return await resolveOpenEventInstance(db, eventSlug);
}

export async function listEventInstances(db, eventSlug) {
  return await domainListEventInstances(db, eventSlug);
}

export async function upsertEvent(db, input, existing = {}) {
  const { event, errors } = normalizeEventInput(input, existing);
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO events (
      slug, title, description, starts_at, ends_at, venue_name, venue_address, capacity, status,
      image_url, page_content, signup_fields_json, recurrence_rule_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      venue_name = excluded.venue_name,
      venue_address = excluded.venue_address,
      capacity = excluded.capacity,
      status = excluded.status,
      image_url = excluded.image_url,
      page_content = excluded.page_content,
      signup_fields_json = excluded.signup_fields_json,
      recurrence_rule_json = excluded.recurrence_rule_json,
      updated_at = excluded.updated_at
  `).bind(
    event.slug,
    event.title,
    event.description,
    event.starts_at,
    event.ends_at,
    event.venue_name,
    event.venue_address,
    event.capacity,
    event.status,
    event.image_url,
    event.page_content,
    event.signup_fields_json,
    event.recurrence_rule_json,
    now,
    now
  ).run();

  const savedEvent = await getEvent(db, event.slug);
  await upsertEventInstance(db, savedEvent);
  return savedEvent;
}

export async function listUsers(db, { limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
  const result = await db.prepare(`
    SELECT
      u.id,
      u.email,
      u.name,
      u.first_name,
      u.last_name,
      u.phone,
      u.school,
      u.metadata_json,
      u.created_at,
      u.updated_at,
      COUNT(s.id) AS signup_count
    FROM users u
    LEFT JOIN signups s ON s.user_id = u.id
    GROUP BY u.id
    ORDER BY u.updated_at DESC, u.created_at DESC
    LIMIT ?
  `).bind(safeLimit).all();
  return result.results || [];
}

export async function listSignups(db, eventSlug, { eventInstanceId = null } = {}) {
  const where = eventInstanceId
    ? "s.event_slug = ? AND s.event_instance_id = ?"
    : "s.event_slug = ?";
  const statement = db.prepare(`
    SELECT
      s.*,
      json_extract(s.metadata_json, '$.signup_role') AS signup_role,
      ei.instance_key,
      ei.starts_at AS instance_starts_at,
      ei.status AS instance_status,
      u.email,
      COALESCE(s.name, u.name) AS name,
      COALESCE(s.first_name, u.first_name) AS first_name,
      COALESCE(s.last_name, u.last_name) AS last_name,
      COALESCE(s.phone, u.phone) AS phone,
      COALESCE(s.school, u.school) AS school,
      pcs.signed_up_at,
      pcs.checked_in_at,
      pcs.checked_out_at,
      pcs.cancelled_at,
      ec.name AS emergency_contact_name,
      ec.relationship AS emergency_contact_relationship,
      ec.phone AS emergency_contact_phone,
      ec.source AS emergency_contact_source,
      ec.updated_at AS emergency_contact_updated_at,
      CASE WHEN ec.id IS NOT NULL AND length(trim(COALESCE(ec.name, ''))) > 0 AND length(trim(COALESCE(ec.phone, ''))) > 0 THEN 1 ELSE 0 END AS emergency_contact_present
    FROM signups s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN event_instances ei ON ei.id = s.event_instance_id
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = s.user_id
    LEFT JOIN emergency_contacts ec
      ON ec.event_instance_id = s.event_instance_id AND ec.user_id = s.user_id
    WHERE ${where}
    ORDER BY COALESCE(ei.starts_at, s.created_at) ASC, s.created_at ASC
  `);
  const result = eventInstanceId
    ? await statement.bind(eventSlug, eventInstanceId).all()
    : await statement.bind(eventSlug).all();
  return result.results || [];
}

export async function createHelperInterest(db, input, currentUser = null) {
  const { helperInterest, errors } = normalizeHelperInterestInput(input, currentUser);
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

  const now = new Date().toISOString();
  const id = input.id && String(input.id).startsWith("hlp_") ? String(input.id) : generateId("hlp");
  await db.prepare(`
    INSERT INTO helper_interests (
      id, created_at, updated_at, user_id, name, email, contact, role_interest,
      availability, event_interest, skills, notes, consent_contact, source, status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    now,
    now,
    helperInterest.user_id,
    helperInterest.name,
    helperInterest.email,
    helperInterest.contact,
    helperInterest.role_interest,
    helperInterest.availability,
    helperInterest.event_interest,
    helperInterest.skills,
    helperInterest.notes,
    helperInterest.consent_contact,
    helperInterest.source,
    helperInterest.status,
    helperInterest.metadata_json
  ).run();

  return await db.prepare("SELECT * FROM helper_interests WHERE id = ?").bind(id).first();
}

export async function listHelperInterests(db, { limit = 200, status = null } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const cleanStatus = trimOrNull(status);
  const sql = `
    SELECT hi.*, u.email AS account_email, u.name AS account_name
    FROM helper_interests hi
    LEFT JOIN users u ON u.id = hi.user_id
    ${cleanStatus ? "WHERE hi.status = ?" : ""}
    ORDER BY hi.created_at DESC
    LIMIT ?
  `;
  const statement = db.prepare(sql);
  const result = cleanStatus
    ? await statement.bind(cleanStatus, safeLimit).all()
    : await statement.bind(safeLimit).all();
  return (result.results || []).map((row) => ({
    ...row,
    consent_contact: Boolean(row.consent_contact),
    metadata: parseJsonObject(row.metadata_json, null)
  }));
}

export async function upsertUser(db, input) {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) {
    throw Object.assign(new Error("valid email is required"), { status: 400 });
  }

  const now = new Date().toISOString();
  const id = input.id && String(input.id).startsWith("usr_") ? String(input.id) : generateId("usr");
  const name = trimOrNull(input.name || `${input.first_name || ""} ${input.last_name || ""}`);
  const metadata = stringifyJson(input.metadata || input.metadata_json || null);

  await db.prepare(`
    INSERT INTO users (
      id, email, name, first_name, last_name, phone, school, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = COALESCE(excluded.name, users.name),
      first_name = COALESCE(excluded.first_name, users.first_name),
      last_name = COALESCE(excluded.last_name, users.last_name),
      phone = COALESCE(excluded.phone, users.phone),
      school = COALESCE(excluded.school, users.school),
      metadata_json = COALESCE(excluded.metadata_json, users.metadata_json),
      updated_at = excluded.updated_at
  `).bind(
    id,
    email,
    name,
    trimOrNull(input.first_name),
    trimOrNull(input.last_name),
    trimOrNull(input.phone),
    trimOrNull(input.school || input.university),
    metadata,
    now,
    now
  ).run();

  return await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
}

export async function updateUserProfile(db, userId, input = {}) {
  if (!userId) throw Object.assign(new Error("userId is required"), { status: 400 });
  const existing = await getUserById(db, userId);
  if (!existing) throw Object.assign(new Error("User not found"), { status: 404 });

  const firstName = trimOrNull(input.first_name ?? input.firstName ?? existing.first_name);
  const lastName = trimOrNull(input.last_name ?? input.lastName ?? existing.last_name);
  const suppliedName = trimOrNull(input.name);
  const composedName = trimOrNull(`${firstName || ""} ${lastName || ""}`);
  const name = suppliedName || composedName || trimOrNull(existing.name) || existing.email;
  const phone = trimOrNull(input.phone ?? existing.phone);
  const school = trimOrNull(input.school ?? input.university ?? existing.school);
  const now = new Date().toISOString();
  const suppliedMetadata = input.metadata ?? input.metadata_json ?? existing.metadata_json;
  const safetyInput = safetyProfileInputFromPatch(input);
  const safetyUpdate = safetyInput
    ? applySafetyProfileToMetadata(suppliedMetadata, safetyInput, { now })
    : { metadata: parseJsonObject(suppliedMetadata, {}), safety: null, changed: false };
  if (safetyUpdate.safety?.hasAny && !safetyUpdate.safety.complete) {
    throw Object.assign(new Error(safetyUpdate.safety.errors.join("; ")), { status: 400, errors: safetyUpdate.safety.errors });
  }
  const metadata = stringifyJson(safetyUpdate.metadata);
  const emergencyContactUpdates = Array.isArray(input.emergency_contacts)
    ? await validateUserProfileEmergencyContacts(db, userId, input.emergency_contacts)
    : [];

  await db.prepare(`
    UPDATE users
    SET name = ?,
        first_name = ?,
        last_name = ?,
        phone = ?,
        school = ?,
        metadata_json = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(name, firstName, lastName, phone, school, metadata, now, userId).run();

  for (const contactUpdate of emergencyContactUpdates) {
    await upsertEmergencyContact(db, contactUpdate);
  }

  return await getUserById(db, userId);
}

async function validateUserProfileEmergencyContacts(db, userId, contacts = []) {
  const signupRows = await db.prepare(`
    SELECT id, event_instance_id
    FROM signups
    WHERE user_id = ? AND event_instance_id IS NOT NULL
  `).bind(userId).all();
  const signupsByInstance = new Map((signupRows.results || []).map((row) => [row.event_instance_id, row]));
  const seen = new Set();
  const updates = [];

  for (const rawContact of contacts) {
    const eventInstanceId = trimOrNull(rawContact?.event_instance_id ?? rawContact?.eventInstanceId);
    if (!eventInstanceId || seen.has(eventInstanceId)) continue;
    seen.add(eventInstanceId);
    const signup = signupsByInstance.get(eventInstanceId);
    if (!signup) {
      throw Object.assign(new Error("Emergency contact can only be updated for your own event signups."), { status: 403 });
    }
    const contact = {
      name: rawContact.name ?? rawContact.emergency_contact_name,
      relationship: rawContact.relationship ?? rawContact.emergency_contact_relationship,
      phone: rawContact.phone ?? rawContact.emergency_contact_phone
    };
    const normalized = normalizeEmergencyContactInput({ emergency_contact: contact });
    if (normalized.errors.length) {
      throw Object.assign(new Error(normalized.errors.join("; ")), { status: 400, errors: normalized.errors });
    }
    updates.push({
      eventInstanceId,
      userId,
      signupId: signup.id,
      contact: normalized.contact,
      source: "profile"
    });
  }
  return updates;
}

export async function upsertSignup(db, eventSlug, input, mailingListResult, eventInstance = null, { requireEmergencyContact = true, source = "signup-api", currentUser = null } = {}) {
  const { signup, errors } = normalizeSignupInput(input, eventSlug, { requireEmergencyContact, currentUser });
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

  const resolvedInstance = eventInstance || await resolveSignupEventInstance(db, eventSlug);
  if (!resolvedInstance) {
    throw Object.assign(new Error("No open instance is available for this event"), { status: 409 });
  }

  const result = await registerParticipation(db, {
    person: currentUser?.id ? currentUser : signup,
    eventSeries: { slug: eventSlug },
    eventInstance: resolvedInstance,
    eventRole: parseJsonObject(signup.metadata_json, {}).signup_role || null,
    safetyInput: requireEmergencyContact || signup.emergency_contact.name || signup.emergency_contact.phone ? signup.emergency_contact : null,
    source,
    signup: { ...signup, id: input.id },
    mailingListResult
  });

  return result.signup;
}

export async function upsertEmergencyContact(db, { eventInstanceId, userId, signupId = null, contact, source = "signup" }) {
  const { contact: normalized, errors } = normalizeEmergencyContactInput({ emergency_contact: contact || {} });
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }
  if (!eventInstanceId || !userId) {
    throw Object.assign(new Error("event_instance_id and user_id are required for emergency contact"), { status: 400 });
  }
  const now = new Date().toISOString();
  const id = generateId("emc");
  await db.prepare(`
    INSERT INTO emergency_contacts (
      id, event_instance_id, user_id, signup_id, name, relationship, phone, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_instance_id, user_id) DO UPDATE SET
      signup_id = COALESCE(excluded.signup_id, emergency_contacts.signup_id),
      name = excluded.name,
      relationship = excluded.relationship,
      phone = excluded.phone,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).bind(
    id,
    eventInstanceId,
    userId,
    signupId,
    normalized.name,
    normalized.relationship,
    normalized.phone,
    source,
    now,
    now
  ).run();
  return await getEmergencyContactStatus(db, eventInstanceId, userId);
}

export async function getEmergencyContactStatus(db, eventInstanceId, userId) {
  if (!eventInstanceId || !userId) return { present: false, contact: null };
  const contact = await db.prepare(`
    SELECT id, event_instance_id, user_id, signup_id, name, relationship, phone, source, created_at, updated_at
    FROM emergency_contacts
    WHERE event_instance_id = ? AND user_id = ?
  `).bind(eventInstanceId, userId).first();
  const present = Boolean(contact && String(contact.name || "").trim() && String(contact.phone || "").trim());
  return { present, contact: contact || null };
}

function progressionLabels(attendanceCount, priorAttendanceCount = 0) {
  const count = Number(attendanceCount || 0);
  const priorCount = Number(priorAttendanceCount || 0);
  if (count >= 3) return ["repeat", "3x attendee"];
  if (count >= 2 || priorCount >= 1) return ["repeat"];
  return ["first-time"];
}

function isRepeatAttendee(row) {
  return (row.progression_labels || []).includes("repeat");
}

export async function listEventPhotos(db, eventSlug, eventInstanceId, { limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const result = await db.prepare(`
    SELECT id, event_slug, event_instance_id, uploaded_by, kind, status, storage_key, public_url,
      original_filename, content_type, bytes, caption, created_at, updated_at
    FROM event_photos
    WHERE event_slug = ? AND event_instance_id = ?
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `).bind(eventSlug, eventInstanceId).all();
  return result.results || [];
}

export async function countEventPhotos(db, eventSlug, eventInstanceId) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM event_photos
    WHERE event_slug = ? AND event_instance_id = ?
  `).bind(eventSlug, eventInstanceId).first();
  return Number(row?.count || 0);
}

export async function createEventPhotoRecord(db, input) {
  const now = new Date().toISOString();
  const id = input.id || generateId("pho");
  await db.prepare(`
    INSERT INTO event_photos (
      id, event_slug, event_instance_id, uploaded_by, kind, status, storage_key, public_url,
      original_filename, content_type, bytes, caption, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.eventSlug,
    input.eventInstanceId,
    input.uploadedBy || null,
    input.kind,
    input.status || "uploaded",
    input.storageKey,
    input.publicUrl || null,
    input.originalFilename || null,
    input.contentType || null,
    input.bytes || null,
    input.caption || null,
    now,
    now
  ).run();
  return {
    id,
    event_slug: input.eventSlug,
    event_instance_id: input.eventInstanceId,
    uploaded_by: input.uploadedBy || null,
    kind: input.kind,
    status: input.status || "uploaded",
    storage_key: input.storageKey,
    public_url: input.publicUrl || null,
    original_filename: input.originalFilename || null,
    content_type: input.contentType || null,
    bytes: input.bytes || null,
    caption: input.caption || null,
    created_at: now,
    updated_at: now
  };
}

export async function getEventCockpit(db, eventSlug, eventInstanceId) {
  const instance = await getEventInstance(db, eventSlug, eventInstanceId);
  if (!instance) {
    throw Object.assign(new Error("Event instance not found"), { status: 404 });
  }
  const event = await getEvent(db, eventSlug);
  if (!event) {
    throw Object.assign(new Error("Event not found"), { status: 404 });
  }
  const [photoRows, eventPhotoCount] = await Promise.all([
    listEventPhotos(db, eventSlug, eventInstanceId, { limit: 8 }),
    countEventPhotos(db, eventSlug, eventInstanceId)
  ]);
  const rosterResult = await db.prepare(`
    SELECT
      u.id AS user_id,
      s.id AS signup_id,
      s.event_instance_id,
      json_extract(s.metadata_json, '$.signup_role') AS signup_role,
      COALESCE(s.name, u.name) AS name,
      u.email,
      1 AS is_signed_up,
      COALESCE(pcs.signed_up_at, s.created_at) AS signed_up_at,
      pcs.checked_in_at,
      ec.name AS emergency_contact_name,
      ec.relationship AS emergency_contact_relationship,
      ec.phone AS emergency_contact_phone,
      ec.updated_at AS emergency_contact_updated_at,
      CASE WHEN ec.id IS NOT NULL AND length(trim(COALESCE(ec.name, ''))) > 0 AND length(trim(COALESCE(ec.phone, ''))) > 0 THEN 1 ELSE 0 END AS emergency_contact_present,
      (
        SELECT COUNT(DISTINCT epe.event_instance_id)
        FROM event_participant_events epe
        WHERE epe.user_id = u.id AND epe.event_type = 'checked_in'
      ) AS attendance_count,
      (
        SELECT COUNT(DISTINCT epe.event_instance_id)
        FROM event_participant_events epe
        WHERE epe.user_id = u.id
          AND epe.event_type = 'checked_in'
          AND epe.event_instance_id IS NOT NULL
          AND epe.event_instance_id <> s.event_instance_id
      ) AS prior_attendance_count
    FROM signups s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = s.user_id
    LEFT JOIN emergency_contacts ec
      ON ec.event_instance_id = s.event_instance_id AND ec.user_id = s.user_id
    WHERE s.event_slug = ? AND s.event_instance_id = ?
    ORDER BY pcs.checked_in_at IS NULL DESC, lower(COALESCE(s.name, u.name, u.email)) ASC
  `).bind(eventSlug, eventInstanceId).all();
  const roster = (rosterResult.results || []).map((row) => {
    const attendanceCount = Number(row.attendance_count || 0);
    const priorAttendanceCount = Number(row.prior_attendance_count || 0);
    return {
      user_id: row.user_id,
      signup_id: row.signup_id,
      event_instance_id: row.event_instance_id,
      signup_role: row.signup_role || null,
      name: row.name,
      email: row.email,
      is_signed_up: Boolean(row.is_signed_up),
      signed_up_at: row.signed_up_at,
      checked_in_at: row.checked_in_at,
      emergency_contact: row.emergency_contact_present ? {
        name: row.emergency_contact_name,
        relationship: row.emergency_contact_relationship || null,
        phone: row.emergency_contact_phone,
        updated_at: row.emergency_contact_updated_at || null
      } : null,
      emergency_contact_present: Boolean(row.emergency_contact_present),
      attendance_count: attendanceCount,
      prior_attendance_count: priorAttendanceCount,
      progression_labels: progressionLabels(attendanceCount, priorAttendanceCount)
    };
  });
  const summary = {
    signed_up_count: roster.length,
    checked_in_count: roster.filter((row) => row.checked_in_at).length,
    missing_emergency_contact_count: roster.filter((row) => !row.emergency_contact_present).length,
    event_photo_count: eventPhotoCount,
    repeat_attendee_count: roster.filter(isRepeatAttendee).length
  };
  return {
    event: { slug: event.slug, title: event.title },
    instance: {
      id: instance.id,
      instance_key: instance.instance_key,
      starts_at: instance.starts_at,
      ends_at: instance.ends_at,
      status: instance.status,
      title: instance.title
    },
    summary,
    roster,
    photos: { count: eventPhotoCount, recent: photoRows }
  };
}

export async function getEventFollowupPacket(db, eventSlug, eventInstanceId) {
  const cockpit = await getEventCockpit(db, eventSlug, eventInstanceId);
  const attended = cockpit.roster.filter((row) => row.checked_in_at);
  const noShow = cockpit.roster.filter((row) => !row.checked_in_at);
  const firstTime = attended.filter((row) => !isRepeatAttendee(row));
  const repeat = attended.filter(isRepeatAttendee);
  const toSegmentRows = (rows, segment) => rows.map((row) => ({
    email: row.email,
    name: row.name,
    segment,
    checked_in_at: row.checked_in_at || null,
    attendance_count: Number(row.attendance_count || 0)
  }));
  const segmentCsv = (rows, segment) => {
    const columns = ["email", "name", "segment", "checked_in_at", "attendance_count"];
    return [
      columns.join(","),
      ...toSegmentRows(rows, segment).map((row) => columns.map((column) => csvEscape(row[column])).join(","))
    ].join("\n");
  };
  const summary = {
    ...cockpit.summary,
    no_show_count: noShow.length,
    first_time_attendee_count: firstTime.length,
    repeat_attendee_count: repeat.length
  };
  const title = cockpit.event.title || "Hack Hours";
  return {
    event: cockpit.event,
    instance: cockpit.instance,
    summary,
    segments: {
      attended: toSegmentRows(attended, "attended"),
      no_show: toSegmentRows(noShow, "no_show"),
      first_time: toSegmentRows(firstTime, "first_time"),
      repeat: toSegmentRows(repeat, "repeat")
    },
    segment_csv: {
      attended: segmentCsv(attended, "attended"),
      no_show: segmentCsv(noShow, "no_show"),
      first_time: segmentCsv(firstTime, "first_time"),
      repeat: segmentCsv(repeat, "repeat")
    },
    followup_draft: {
      status: "needs_review",
      requires_approval: true,
      channel: "resend_or_copy",
      subject: `Thanks for coming to ${title}`,
      preview_text: `Draft only: thank attendees, share next Hack Hours, and invite no-shows to the next session. No send occurs from this endpoint.`,
      audience_segments: ["attended", "no_show", "first_time", "repeat"]
    }
  };
}

export async function getUserById(db, userId) {
  if (!userId) return null;
  return await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
}

export async function getEventInstance(db, eventSlug, eventInstanceId) {
  if (!eventInstanceId) return null;
  return await db.prepare("SELECT * FROM event_instances WHERE event_slug = ? AND id = ?").bind(eventSlug, eventInstanceId).first();
}

async function getSignupByInstanceAndUser(db, eventSlug, eventInstanceId, userId) {
  if (!eventInstanceId || !userId) return null;
  return await db.prepare(`
    SELECT
      s.*,
      json_extract(s.metadata_json, '$.signup_role') AS signup_role,
      ei.instance_key,
      ei.starts_at AS instance_starts_at,
      ei.status AS instance_status,
      u.email,
      COALESCE(s.name, u.name) AS name,
      COALESCE(s.first_name, u.first_name) AS first_name,
      COALESCE(s.last_name, u.last_name) AS last_name,
      COALESCE(s.phone, u.phone) AS phone,
      COALESCE(s.school, u.school) AS school,
      pcs.signed_up_at,
      pcs.checked_in_at,
      pcs.checked_out_at,
      pcs.cancelled_at
    FROM signups s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN event_instances ei ON ei.id = s.event_instance_id
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = s.user_id
    WHERE s.event_slug = ? AND s.event_instance_id = ? AND s.user_id = ?
  `).bind(eventSlug, eventInstanceId, userId).first();
}

export async function searchCheckinCandidates(db, eventSlug, { eventInstanceId, query = "", limit = 25 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const trimmed = String(query || "").trim().toLowerCase();
  if (!eventInstanceId) {
    throw Object.assign(new Error("event_instance_id is required for check-in search"), { status: 400 });
  }
  if (!trimmed) {
    const result = await db.prepare(`
      SELECT
        u.id,
        u.email,
        COALESCE(s.name, u.name) AS name,
        COALESCE(s.first_name, u.first_name) AS first_name,
        COALESCE(s.last_name, u.last_name) AS last_name,
        COALESCE(s.phone, u.phone) AS phone,
        s.id AS signup_id,
        s.event_slug,
        s.event_instance_id,
        s.email_list_opt_in,
        1 AS is_signed_up,
        pcs.checked_in_at,
        CASE WHEN ec.id IS NOT NULL AND length(trim(COALESCE(ec.name, ''))) > 0 AND length(trim(COALESCE(ec.phone, ''))) > 0 THEN 1 ELSE 0 END AS emergency_contact_present
      FROM signups s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN event_participant_current_state pcs
        ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = u.id
      LEFT JOIN emergency_contacts ec
        ON ec.event_instance_id = s.event_instance_id AND ec.user_id = u.id
      WHERE s.event_slug = ? AND s.event_instance_id = ?
      ORDER BY pcs.checked_in_at IS NULL DESC, lower(COALESCE(s.name, u.name, u.email)) ASC
      LIMIT ${safeLimit}
    `).bind(eventSlug, eventInstanceId).all();
    return result.results || [];
  }
  const like = `%${trimmed}%`;
  const result = await db.prepare(`
    SELECT
      u.id,
      u.email,
      u.name,
      u.first_name,
      u.last_name,
      u.phone,
      s.id AS signup_id,
      s.event_slug,
      s.event_instance_id,
      s.email_list_opt_in,
      CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS is_signed_up,
      pcs.checked_in_at,
      CASE WHEN ec.id IS NOT NULL AND length(trim(COALESCE(ec.name, ''))) > 0 AND length(trim(COALESCE(ec.phone, ''))) > 0 THEN 1 ELSE 0 END AS emergency_contact_present
    FROM users u
    LEFT JOIN signups s
      ON s.user_id = u.id AND s.event_instance_id = ?
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = u.id
    LEFT JOIN emergency_contacts ec
      ON ec.event_instance_id = s.event_instance_id AND ec.user_id = u.id
    WHERE lower(u.email) LIKE ?
       OR lower(COALESCE(u.name, '')) LIKE ?
       OR lower(trim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))) LIKE ?
    ORDER BY is_signed_up DESC, pcs.checked_in_at IS NULL DESC, lower(COALESCE(u.name, u.email)) ASC
    LIMIT ${safeLimit}
  `).bind(eventInstanceId, like, like, like).all();
  return result.results || [];
}

export async function checkInAttendee(db, event, input, { eventInstance = null, actor = "admin", source = "admin-checkin", syncEmailList = null } = {}) {
  const resolvedInstance = eventInstance || await resolveSignupEventInstance(db, event.slug);
  if (!resolvedInstance) {
    throw Object.assign(new Error("No open instance is available for this event"), { status: 409 });
  }

  let userInput = { ...input };
  if (input.user_id && (!input.email || !input.name)) {
    const existingUser = await getUserById(db, input.user_id);
    if (!existingUser) throw Object.assign(new Error("User not found"), { status: 404 });
    userInput = {
      ...existingUser,
      ...input,
      email: input.email || existingUser.email,
      name: input.name || existingUser.name || `${existingUser.first_name || ""} ${existingUser.last_name || ""}`.trim(),
      first_name: input.first_name || existingUser.first_name,
      last_name: input.last_name || existingUser.last_name,
      phone: input.phone || existingUser.phone,
      school: input.school || existingUser.school
    };
  }

  let savedSignup = input.user_id
    ? await getSignupByInstanceAndUser(db, event.slug, resolvedInstance.id, input.user_id)
    : null;

  if (!savedSignup) {
    const { signup, errors } = normalizeSignupInput(userInput, event.slug, { requireEmergencyContact: !input.user_id });
    if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
    const mailingListResult = syncEmailList
      ? await syncEmailList(signup)
      : { status: "skipped_not_configured", detail: "No email-list sync callback configured" };
    savedSignup = await upsertSignup(db, event.slug, userInput, mailingListResult, resolvedInstance, {
      requireEmergencyContact: !input.user_id,
      source
    });
  } else if (input.emergency_contact_name || input.emergency_contact_phone || input.emergency_contact?.name || input.emergency_contact?.phone) {
    const { contact, errors } = normalizeEmergencyContactInput(input);
    if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
    await upsertEmergencyContact(db, {
      eventInstanceId: resolvedInstance.id,
      userId: savedSignup.user_id,
      signupId: savedSignup.id,
      contact,
      source: "admin-checkin"
    });
  }

  if (!input.user_id) {
    const emergency = await getEmergencyContactStatus(db, resolvedInstance.id, savedSignup.user_id);
    if (!emergency.present) {
      throw Object.assign(new Error("Emergency contact is required before check-in."), { status: 409, code: "missing_emergency_contact" });
    }
  }

  const checkin = await checkInParticipant(db, {
    personId: savedSignup.user_id,
    eventInstanceId: resolvedInstance.id,
    actor,
    source
  });

  return {
    event,
    instance: resolvedInstance,
    signup: checkin.signup,
    checked_in_at: checkin.checked_in_at,
    already_checked_in: checkin.already_checked_in
  };
}

export async function addSignupToEmailList(env, signup, event) {
  if (!signup.email_list_opt_in) {
    return { status: "skipped_opt_out", detail: "Registrant opted out of community email list" };
  }

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return { status: "skipped_not_configured", detail: "RESEND_API_KEY is not configured" };
  }

  const contactBody = {
    email: signup.email,
    first_name: signup.first_name || undefined,
    last_name: signup.last_name || undefined,
    unsubscribed: false
  };

  const created = await resendFetch(env, "/contacts", {
    method: "POST",
    body: JSON.stringify(contactBody)
  });

  let contactStatus = "created";
  if (!created.ok) {
    if (created.status === 409 || created.status === 422) {
      const patched = await resendFetch(env, `/contacts/${encodeURIComponent(signup.email)}`, {
        method: "PATCH",
        body: JSON.stringify({
          first_name: contactBody.first_name,
          last_name: contactBody.last_name
        })
      });
      if (!patched.ok) {
        return { status: "failed", detail: `Resend contact update failed: ${patched.status} ${await safeText(patched)}`.slice(0, 500) };
      }
      contactStatus = "updated";
    } else {
      return { status: "failed", detail: `Resend contact create failed: ${created.status} ${await safeText(created)}`.slice(0, 500) };
    }
  }

  return { status: "synced", detail: `Resend contact ${contactStatus}; event signup stored in HTV_DB` };
}

async function resendFetch(env, path, init) {
  return await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "hack-the-valley-events/1.0",
      ...(init.headers || {})
    }
  });
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function csvEscape(value) {
  let str = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@]/.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
}

export function signupsToCsv(signups) {
  const columns = [
    "created_at", "updated_at", "event_slug", "event_instance_id", "instance_key", "signup_role", "user_id", "name", "email", "phone", "school", "year",
    "experience", "notes", "email_list_opt_in", "signed_up_at", "checked_in_at", "checked_out_at", "cancelled_at",
    "emergency_contact_present", "emergency_contact_name", "emergency_contact_relationship", "emergency_contact_phone", "emergency_contact_source", "emergency_contact_updated_at",
    "metadata_json", "mailing_list_status", "mailing_list_detail"
  ];
  return [
    columns.join(","),
    ...signups.map((row) => columns.map((column) => csvEscape(row[column])).join(","))
  ].join("\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderText(value) {
  return escapeHtml(value || "")
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}

function formatEventDate(value) {
  if (!value) return "Date TBA";
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" }).format(new Date(value));
  } catch {
    return value;
  }
}

export function renderEventPageHtml(event) {
  const signupOpen = event.status === "open";
  const title = escapeHtml(event.title);
  const slug = escapeHtml(event.slug);
  const description = escapeHtml(event.description || "Hack the Valley community event.");
  const content = renderText(event.page_content || event.description || "More event details are coming soon.");
  const image = event.image_url ? `<img class="event-hero-image" src="${escapeHtml(event.image_url)}" alt="${title}">` : "";
  const venueParts = [event.venue_name, event.venue_address].filter(Boolean);
  const venue = escapeHtml(venueParts.length ? venueParts.join(" • ") : "Location TBA");
  const when = escapeHtml(formatEventDate(event.starts_at));
  const roleConfig = signupRoleConfigForEvent(event);
  const roleField = roleConfig.roles.length > 1 ? `
      <fieldset class="signup-role-field">
        <legend>${escapeHtml(roleConfig.label)}</legend>
        ${roleConfig.roles.map((role) => `<label class="role-option"><input name="signup_role" type="radio" value="${escapeHtml(role.value)}" ${role.value === roleConfig.default_role ? "checked" : ""}> <span><strong>${escapeHtml(role.label)}</strong>${role.description ? `<small>${escapeHtml(role.description)}</small>` : ""}</span></label>`).join("")}
      </fieldset>` : (roleConfig.default_role ? `<input name="signup_role" type="hidden" value="${escapeHtml(roleConfig.default_role)}">` : "");
  const signupForm = signupOpen ? `
    <form id="signup-form" class="signup-card">
      <h2>Save your spot</h2>
      <p class="signup-help">Emergency contact is for event safety only — not profile enrichment.</p>
      <p id="signed-in-signup-note" class="signed-in-signup-note" hidden></p>
      ${roleField}
      <label data-profile-signup-field>Name <input name="name" required autocomplete="name"></label>
      <label data-profile-signup-field>Email <input name="email" type="email" required autocomplete="email"></label>
      <label data-profile-signup-field>Emergency contact name <input name="emergency_contact_name" required autocomplete="off"></label>
      <label data-profile-signup-field>Emergency contact phone <input name="emergency_contact_phone" required autocomplete="tel"></label>
      <label class="checkbox" data-email-list-field><input name="email_list_opt_in" type="checkbox" checked> Send me Hack the Valley updates</label>
      <button type="submit">Save my spot</button>
      <p id="form-message" role="status"></p>
    </form>
    <script>
      const signupForm = document.getElementById("signup-form");
      let signedInUser = null;
      async function applySignedInSignupMode() {
        try {
          const response = await fetch("/api/me", { headers: { Accept: "application/json" } });
          if (!response.ok) return;
          const data = await response.json();
          signedInUser = data.user || null;
          if (!signedInUser) return;
          const note = document.getElementById("signed-in-signup-note");
          note.hidden = false;
          note.textContent = "You're signed in as " + (signedInUser.name || signedInUser.email) + ". This signup only needs your event choice.";
          signupForm.querySelectorAll("[data-profile-signup-field], [data-email-list-field]").forEach((field) => {
            field.hidden = true;
            field.querySelectorAll("input, textarea, select").forEach((input) => {
              input.required = false;
              input.disabled = true;
            });
          });
        } catch (_) {}
      }
      applySignedInSignupMode();

      signupForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector("button");
        const message = document.getElementById("form-message");
        button.disabled = true;
        message.textContent = "Submitting…";
        const body = Object.fromEntries(new FormData(form).entries());
        if (signedInUser) body.signed_in_signup = true;
        body.email_list_opt_in = new FormData(form).get("email_list_opt_in") === "on";
        body.source = "event-detail-page";
        try {
          const response = await fetch("/api/events/${slug}/signups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Signup failed");
          form.reset();
          button.textContent = "You're signed up";
          message.textContent = "You're on the list. Emergency contact saved. Check-in QR/token support is coming; organizers can check you in by search today.";
        } catch (error) {
          button.disabled = false;
          message.textContent = error.message;
        }
      });
    </script>` : `<div class="signup-card"><h2>Signups are ${escapeHtml(event.status || "closed")}</h2><p>This event is not currently accepting signups.</p></div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Hack the Valley</title>
  <meta name="description" content="${description}">
  <style>
    body{margin:0;background:#0f172a;color:#f8fafc;font-family:Inter,ui-sans-serif,system-ui,sans-serif}a{color:#67e8f9}.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 72px}.nav{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px;margin-bottom:48px}.brand{font-weight:900;text-decoration:none;color:#fff}.participant-nav{display:flex;flex-wrap:wrap;gap:8px;font-size:.9rem;font-weight:800}.participant-nav a{border-radius:999px;padding:8px 12px;text-decoration:none;color:#cbd5e1}.participant-nav a:hover{background:#1e293b;color:#67e8f9}.participant-nav a[aria-current="page"]{background:rgba(103,232,249,.14);box-shadow:inset 0 0 0 1px rgba(103,232,249,.36);color:#67e8f9}.hero{display:grid;gap:28px}.kicker{text-transform:uppercase;letter-spacing:.24em;color:#67e8f9;font-weight:800;font-size:.8rem}h1{font-size:clamp(2.5rem,7vw,5.5rem);line-height:.92;margin:.25em 0}.lede{font-size:1.25rem;color:#cbd5e1;max-width:760px}.event-hero-image{width:100%;max-height:760px;object-fit:contain;background:#020617;border-radius:28px;border:1px solid #334155}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:28px 0}.meta div,.content,.signup-card{background:#111827;border:1px solid #334155;border-radius:22px;padding:22px}.content{font-size:1.08rem;line-height:1.7;color:#dbeafe}.content p{margin:0 0 1em}.signup-card{margin-top:28px;max-width:680px}.signup-card label{display:block;margin:14px 0;color:#cbd5e1}.signup-card input,.signup-card textarea{box-sizing:border-box;width:100%;margin-top:6px;border-radius:12px;border:1px solid #475569;background:#020617;color:#fff;padding:12px}.signup-role-field{border:1px solid #334155;border-radius:16px;padding:14px;margin:14px 0}.signup-role-field legend{font-weight:900;color:#f8fafc}.role-option{display:flex!important;gap:10px;align-items:flex-start;border:1px solid #334155;border-radius:12px;padding:12px}.role-option input{width:auto;margin-top:3px}.role-option strong{display:block;color:#fff}.role-option small{display:block;color:#94a3b8;margin-top:4px}.checkbox{display:flex!important;gap:10px;align-items:flex-start}.checkbox input{width:auto;margin-top:3px}.signed-in-signup-note{border:1px solid rgba(103,232,249,.35);background:rgba(103,232,249,.12);color:#cffafe;border-radius:14px;padding:12px 14px}button{border:0;border-radius:999px;padding:13px 22px;background:#67e8f9;color:#020617;font-weight:900;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}#form-message{color:#cbd5e1}.signup-help{color:#94a3b8;margin-top:0}
  </style>
</head>
<body data-event-detail-page="${slug}">
  <main class="wrap">
    <nav class="nav" aria-label="Participant"><a class="brand" href="/">Hack the Valley</a><div data-participant-nav class="participant-nav"><a data-nav-link="events" href="/events" aria-current="page">Events</a><a data-nav-link="projects" href="/projects/">Projects</a><a data-nav-link="profile" href="/login/?next=/me/">Profile</a><a data-nav-link="leaderboard" href="/leaderboard/">Leaderboard</a></div></nav>
    <section class="hero">
      <div><p class="kicker">Event page</p><h1>${title}</h1><p class="lede">${description}</p></div>
      ${image}
    </section>
    <section class="meta"><div><strong>When</strong><br>${when}</div><div><strong>Where</strong><br>${venue}</div></section>
    <section class="content">${content}</section>
    ${signupForm}
  </main>
</body>
</html>`;
}

export async function handleErrors(fn) {
  try {
    return await fn();
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return jsonResponse({ error: error.message || "Internal server error", errors: error.errors, code: error.code }, { status });
  }
}
