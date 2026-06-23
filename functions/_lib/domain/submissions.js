import { resolveOpenEventInstance } from "./events.js";
import { getOwnedProject, sanitizeProjectRow, upsertProject } from "./projects.js";
import { parseJsonArray } from "./shared.js";

const EVENT_PROJECT_SUBMISSION_STATUSES = new Set(["submitted", "accepted", "showcased", "winner", "rejected", "hidden"]);

export async function submitProjectToEvent(db, {
  projectId,
  eventSlug,
  eventInstanceId = null,
  submissionId = null,
  status = "submitted",
  source = "submission_portal",
  now = new Date().toISOString()
} = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  if (!projectId) throw Object.assign(new Error("projectId is required"), { status: 400 });
  if (!eventSlug) throw Object.assign(new Error("eventSlug is required"), { status: 400 });
  const normalizedStatus = normalizeSubmissionStatus(status);
  return await linkProjectSubmission(db, {
    eventSlug,
    eventInstanceId,
    projectId,
    submissionId,
    status: normalizedStatus,
    source,
    now
  });
}

export async function submitOwnedProjectToEvent(db, userId, projectId, input = {}) {
  const project = await getOwnedProject(db, userId, projectId);
  const eventSlug = input.event_slug || input.eventSlug;
  if (!eventSlug) throw Object.assign(new Error("event_slug is required"), { status: 400 });
  const explicitInstanceId = input.event_instance_id || input.eventInstanceId || null;
  const existingSubmission = await db.prepare(`
    SELECT id, status
    FROM event_project_submissions
    WHERE event_slug = ? AND project_id = ?
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).bind(eventSlug, project.id).first();
  if (["hidden", "rejected"].includes(existingSubmission?.status)) {
    throw Object.assign(new Error("This project submission was closed by an organizer. Ask an organizer to restore it before submitting again."), { status: 409 });
  }
  if (["accepted", "showcased", "winner"].includes(existingSubmission?.status)) {
    return { project: sanitizeProjectRow(project), submission: existingSubmission };
  }
  const eventInstance = explicitInstanceId ? null : await resolveOpenEventInstance(db, eventSlug);
  const submission = await submitProjectToEvent(db, {
    eventSlug,
    eventInstanceId: explicitInstanceId || eventInstance?.id || null,
    projectId: project.id,
    submissionId: input.submission_id || input.submissionId || project.canonical_submission_id || null,
    status: "submitted",
    source: "participant_dashboard"
  });
  return { project: sanitizeProjectRow(project), submission };
}

export async function setEventProjectSubmissionStatus(db, { submissionId, status = "hidden", actor = null, now = new Date().toISOString() } = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  if (!submissionId) throw Object.assign(new Error("submissionId is required"), { status: 400 });
  const normalizedStatus = normalizeSubmissionStatus(status);
  const existing = await db.prepare(`
    SELECT eps.*, p.title, p.team_name
    FROM event_project_submissions eps
    JOIN projects p ON p.id = eps.project_id
    WHERE eps.id = ?
    LIMIT 1
  `).bind(submissionId).first();
  if (!existing) throw Object.assign(new Error("Event project submission not found"), { status: 404 });
  await db.prepare(`
    UPDATE event_project_submissions
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).bind(normalizedStatus, now, submissionId).run();
  return {
    ...existing,
    status: normalizedStatus,
    updated_at: now,
    actor: actor || null
  };
}

export async function updateEventProjectSubmissionStatus(db, { eventSlug, projectId, status = "hidden", actor = null, now = new Date().toISOString() } = {}) {
  if (!eventSlug) throw Object.assign(new Error("eventSlug is required"), { status: 400 });
  if (!projectId) throw Object.assign(new Error("projectId is required"), { status: 400 });
  const normalizedStatus = normalizeSubmissionStatus(status);
  const existing = await db.prepare(`
    SELECT eps.*, p.title, p.team_name
    FROM event_project_submissions eps
    JOIN projects p ON p.id = eps.project_id
    WHERE eps.event_slug = ? AND eps.project_id = ?
    LIMIT 1
  `).bind(eventSlug, projectId).first();
  if (!existing) throw Object.assign(new Error("Event project submission not found"), { status: 404 });
  await db.prepare(`
    UPDATE event_project_submissions
    SET status = ?, updated_at = ?
    WHERE event_slug = ? AND project_id = ?
  `).bind(normalizedStatus, now, eventSlug, projectId).run();
  return {
    ...existing,
    status: normalizedStatus,
    updated_at: now,
    actor: actor || null
  };
}

export async function linkProjectSubmission(db, {
  eventSlug,
  eventInstanceId = null,
  projectId,
  submissionId = null,
  status = "submitted",
  source = "submission_portal",
  now = new Date().toISOString()
} = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  if (!eventSlug) throw Object.assign(new Error("eventSlug is required"), { status: 400 });
  if (!projectId) throw Object.assign(new Error("projectId is required"), { status: 400 });
  const normalizedStatus = normalizeSubmissionStatus(status);
  const id = `eps_${eventSlug}_${eventInstanceId || "event"}_${projectId}_${submissionId || "manual"}`.replace(/[^a-zA-Z0-9_]+/g, "_");
  await db.prepare(`
    INSERT INTO event_project_submissions (
      id, event_slug, event_instance_id, project_id, submission_id, status, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).bind(id, eventSlug, eventInstanceId, projectId, submissionId, normalizedStatus, source, now, now).run();
  return {
    id,
    event_project_submission_id: id,
    event_slug: eventSlug,
    event_instance_id: eventInstanceId,
    project_id: projectId,
    submission_id: submissionId,
    status: normalizedStatus,
    source,
    updated_at: now
  };
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

export async function listEventProjectSubmissions(db, filters = {}, maybeEventInstanceId = null, maybeOptions = {}) {
  const normalized = normalizeListEventSubmissionFilters(filters, maybeEventInstanceId, maybeOptions);
  const { eventSlug, eventInstanceId, includeHidden = false } = normalized;
  if (!eventSlug) throw Object.assign(new Error("eventSlug is required"), { status: 400 });
  const statusFilter = includeHidden ? "" : "AND eps.status != 'hidden'";
  const instanceFilter = eventInstanceId ? "AND eps.event_instance_id = ?" : "";
  const args = eventInstanceId ? [eventSlug, eventInstanceId] : [eventSlug];
  const result = await db.prepare(`
    SELECT
      eps.id AS event_project_submission_id,
      eps.event_slug,
      eps.event_instance_id,
      eps.status,
      eps.source,
      eps.created_at,
      eps.updated_at,
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

export function sanitizePublicProjectRow(row = {}) {
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

function normalizeListEventSubmissionFilters(filters, maybeEventInstanceId, maybeOptions) {
  if (typeof filters === "string") {
    return { eventSlug: filters, eventInstanceId: maybeEventInstanceId || null, ...(maybeOptions || {}) };
  }
  return {
    eventSlug: filters.eventSlug || filters.event_slug || null,
    eventInstanceId: filters.eventInstanceId || filters.event_instance_id || null,
    includeHidden: Boolean(filters.includeHidden || filters.include_hidden)
  };
}

function normalizeSubmissionStatus(status) {
  const normalized = String(status || "submitted").trim().toLowerCase();
  if (!EVENT_PROJECT_SUBMISSION_STATUSES.has(normalized)) {
    throw Object.assign(new Error("Unsupported project submission status"), { status: 400 });
  }
  return normalized;
}

function normalizeTracks(value) {
  if (Array.isArray(value)) return value.map((track) => String(track).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[|,]/).map((track) => track.trim()).filter(Boolean);
  return [];
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

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
