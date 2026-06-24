import { appendAuditEvent, buildAuditEvent } from "./audit.js";
import { parseJsonObject, stringOrNull } from "./shared.js";

export const DEFAULT_BADGES = Object.freeze({
  "first-attendance": { id: "bdg_first_attendance", name: "First Attendance", description: "Showed up to a Hack the Valley event.", badge_type: "attendance" },
  "repeat-attendee": { id: "bdg_repeat_attendee", name: "Repeat Attendee", description: "Came back for another Hack the Valley event.", badge_type: "attendance" },
  "three-time-attendee": { id: "bdg_three_time_attendee", name: "3x Attendee", description: "Attended three Hack the Valley sessions.", badge_type: "attendance" },
  "shared-demo": { id: "bdg_shared_demo", name: "Shared a Demo", description: "Shared a project or demo with the community.", badge_type: "demo" },
  "helped-mentor": { id: "bdg_helped_mentor", name: "Helped or Mentored", description: "Helped another builder, mentored, or organized.", badge_type: "contribution" },
  "attended-htv-2026": { id: "bdg_attended_htv_2026", name: "HTV 2026 Attendee", description: "Checked in at Hack the Valley 2026.", badge_type: "attendance" },
  "won-prize-htv-2026": { id: "bdg_won_prize_htv_2026", name: "HTV 2026 Prize Winner", description: "Won a prize at Hack the Valley 2026.", badge_type: "award" },
  "won-overall-htv-2026": { id: "bdg_won_overall_htv_2026", name: "HTV 2026 Overall Winner", description: "Won the Overall Prize at Hack the Valley 2026.", badge_type: "award" },
  "submitted-project": { id: "bdg_submitted_project", name: "Project Shipper", description: "Submitted a project to the Hack the Valley community.", badge_type: "project" },
  "attended-hack-hours": { id: "bdg_attended_hack_hours", name: "Hack Hours Regular", description: "Checked in at a Hack Hours event.", badge_type: "attendance" }
});

export function slugifyBadge(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function defaultBadgeForSlug(slug) {
  const safeSlug = slugifyBadge(slug);
  return DEFAULT_BADGES[safeSlug] || {
    id: `bdg_${safeSlug.replace(/-/g, "_")}`,
    name: safeSlug.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
    description: null,
    badge_type: "community"
  };
}

export function badgeIconUrl(slug) {
  return `/images/badges/${encodeURIComponent(slug || "community")}.svg`;
}

export function decorateBadge(row = {}) {
  const defaults = defaultBadgeForSlug(row.slug || "community");
  const slug = row.slug || defaults.id.replace(/^bdg_/, "").replace(/_/g, "-");
  return {
    id: row.id || row.badge_id || defaults.id,
    award_id: row.award_id || (String(row.id || "").startsWith("ubg_") ? row.id : null),
    slug,
    name: row.name || defaults.name,
    description: row.description ?? defaults.description,
    badge_type: row.badge_type || defaults.badge_type,
    event_instance_id: row.event_instance_id || null,
    project_id: row.project_id || null,
    source: row.source || "derived",
    awarded_by: row.awarded_by || null,
    awarded_at: row.awarded_at || row.occurred_at || null,
    revoked_at: row.revoked_at || null,
    revoked_by: row.revoked_by || null,
    revoke_reason: row.revoke_reason || null,
    icon_url: row.icon_url || badgeIconUrl(slug)
  };
}

export function dedupeBadges(badges = []) {
  const seen = new Set();
  const output = [];
  for (const badge of badges.map(decorateBadge)) {
    if (!badge.slug || seen.has(badge.slug)) continue;
    seen.add(badge.slug);
    output.push(badge);
  }
  return output;
}

export async function listBadgeCatalog(db, options = {}) {
  const includeInactive = Boolean(options.includeInactive ?? options.include_inactive);
  const type = stringOrNull(options.badgeType ?? options.badge_type ?? options.type);
  const filters = [];
  const args = [];
  if (!includeInactive) filters.push("active = 1");
  if (type) {
    filters.push("badge_type = ?");
    args.push(type);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await db.prepare(`
    SELECT id, slug, name, description, badge_type, rule_json, active, created_at, updated_at
    FROM badges
    ${where}
    ORDER BY badge_type ASC, lower(name) ASC, slug ASC
  `).bind(...args).all();
  return (result.results || []).map(toBadgeCatalogItem);
}

export async function ensureBadge(db, { slug, name, description = null, badge_type = "community", rule_json = null } = {}) {
  const safeSlug = slugifyBadge(slug || name);
  if (!safeSlug) throw Object.assign(new Error("badge slug is required"), { status: 400 });
  const defaults = defaultBadgeForSlug(safeSlug);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO badges (id, slug, name, description, badge_type, rule_json, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      name = COALESCE(excluded.name, badges.name),
      description = COALESCE(excluded.description, badges.description),
      badge_type = COALESCE(excluded.badge_type, badges.badge_type),
      rule_json = COALESCE(excluded.rule_json, badges.rule_json),
      active = 1,
      updated_at = excluded.updated_at
  `).bind(
    defaults.id,
    safeSlug,
    name || defaults.name,
    description ?? defaults.description,
    badge_type || defaults.badge_type,
    stringifyJson(rule_json),
    now,
    now
  ).run();
  return await db.prepare("SELECT * FROM badges WHERE slug = ?").bind(safeSlug).first();
}

export async function listPersonBadgesForAdminRoute(db, { personId } = {}) {
  return await listPersonBadges(db, personId);
}

export async function awardPersonBadgeFromAdminRoute(db, { personId, input = {}, access = {} } = {}) {
  const provenance = trustedAdminBadgeProvenance(access);
  return await awardBadge(db, {
    personId,
    badgeSlug: input.badgeSlug ?? input.badge_slug ?? input.slug,
    badge: input.badge,
    eventInstanceId: input.eventInstanceId ?? input.event_instance_id ?? null,
    projectId: input.projectId ?? input.project_id ?? null,
    source: provenance.source,
    awardedBy: provenance.actorUserId
  });
}

export async function revokePersonBadgeFromAdminRoute(db, { input = {}, query = {}, access = {} } = {}) {
  const provenance = trustedAdminBadgeProvenance(access);
  return await revokeBadgeAward(db, {
    awardId: firstBadgeRouteValue(input.awardId, input.award_id, queryValue(query, "awardId"), queryValue(query, "award_id")),
    actorUserId: provenance.actorUserId,
    reason: firstBadgeRouteValue(input.reason, input.revoke_reason, queryValue(query, "reason"), queryValue(query, "revoke_reason"))
  });
}

export function trustedAdminBadgeProvenance(access = {}) {
  return {
    source: access.bootstrap ? "bootstrap_admin" : "admin",
    actorUserId: stringOrNull(access.user?.id ?? access.actorUserId ?? access.actor_user_id)
  };
}

export async function awardBadge(db, input = {}) {
  const personId = stringOrNull(input.personId ?? input.person_id ?? input.userId ?? input.user_id);
  if (!personId) throw Object.assign(new Error("personId is required"), { status: 400 });
  const badgeSlug = input.badgeSlug ?? input.badge_slug ?? input.slug;
  const ensuredBadge = await ensureBadge(db, input.badge || { slug: badgeSlug });
  if (!ensuredBadge) throw Object.assign(new Error("Badge could not be created"), { status: 500 });

  const eventInstanceId = stringOrNull(input.eventInstanceId ?? input.event_instance_id);
  const projectId = stringOrNull(input.projectId ?? input.project_id);
  const source = stringOrNull(input.source) || "admin";
  const awardedBy = stringOrNull(input.awardedBy ?? input.awarded_by ?? input.actorUserId ?? input.actor_user_id);
  const existing = await findBadgeAward(db, {
    personId,
    badgeId: ensuredBadge.id,
    eventInstanceId,
    includeRevoked: false
  });
  if (existing) {
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT OR IGNORE INTO user_badges (
        id, user_id, badge_id, event_instance_id, project_id, source, awarded_by, awarded_at, created_at, revoked_at, revoked_by, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).bind(
      existing.id,
      personId,
      ensuredBadge.id,
      eventInstanceId,
      existing.project_id || projectId,
      existing.source || source,
      existing.awarded_by || awardedBy,
      existing.awarded_at || now,
      existing.created_at || now
    ).run();
    return {
      badge: ensuredBadge,
      award: existing,
      created: false,
      duplicate: true,
      reactivated: false,
      auditEvent: null
    };
  }

  const now = new Date().toISOString();
  const revoked = await findBadgeAward(db, {
    personId,
    badgeId: ensuredBadge.id,
    eventInstanceId,
    includeRevoked: true,
    onlyRevoked: true
  });
  let award;
  let reactivated = false;

  if (revoked) {
    reactivated = true;
    await db.prepare(`
      UPDATE user_badges
      SET project_id = ?,
          source = ?,
          awarded_by = ?,
          awarded_at = ?,
          revoked_at = NULL,
          revoked_by = NULL,
          revoke_reason = NULL
      WHERE id = ?
    `).bind(projectId, source, awardedBy, now, revoked.id).run();
    award = await selectBadgeAwardById(db, revoked.id);
  } else {
    const id = badgeAwardId({ personId, badgeId: ensuredBadge.id, eventInstanceId, projectId });
    await db.prepare(`
      INSERT OR IGNORE INTO user_badges (
        id, user_id, badge_id, event_instance_id, project_id, source, awarded_by, awarded_at, created_at, revoked_at, revoked_by, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).bind(id, personId, ensuredBadge.id, eventInstanceId, projectId, source, awardedBy, now, now).run();
    award = await findBadgeAward(db, {
      personId,
      badgeId: ensuredBadge.id,
      eventInstanceId,
      includeRevoked: false
    }) || { id, user_id: personId, badge_id: ensuredBadge.id, event_instance_id: eventInstanceId, project_id: projectId, source, awarded_by: awardedBy, awarded_at: now, created_at: now, revoked_at: null };
  }

  const auditEvent = await appendBadgeAwardAudit(db, { award, badge: ensuredBadge, source, actorUserId: awardedBy, reactivated });
  return {
    badge: ensuredBadge,
    award,
    created: !reactivated,
    duplicate: false,
    reactivated,
    auditEvent
  };
}

export async function revokeBadgeAward(db, input = {}) {
  const awardId = stringOrNull(input.awardId ?? input.award_id);
  const actorUserId = stringOrNull(input.actorUserId ?? input.actor_user_id ?? input.revokedBy ?? input.revoked_by);
  const reason = stringOrNull(input.reason ?? input.revoke_reason);
  if (!awardId) throw Object.assign(new Error("awardId is required"), { status: 400 });
  if (!reason) throw Object.assign(new Error("revoke reason is required"), { status: 400 });

  const existing = await selectBadgeAwardById(db, awardId);
  if (!existing) throw Object.assign(new Error("Badge award not found"), { status: 404 });
  if (existing.revoked_at) {
    return { award: existing, revoked: false, alreadyRevoked: true, auditEvent: null };
  }

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE user_badges
    SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
    WHERE id = ? AND revoked_at IS NULL
  `).bind(now, actorUserId, reason, awardId).run();
  const award = await selectBadgeAwardById(db, awardId) || { ...existing, revoked_at: now, revoked_by: actorUserId, revoke_reason: reason };
  const auditEvent = await appendAuditEvent(db, buildAuditEvent({
    action: "badge.revoke",
    actorUserId,
    targetType: "badge_award",
    targetId: award.id,
    metadata: {
      personId: award.user_id,
      badgeId: award.badge_id,
      badgeSlug: award.slug,
      eventInstanceId: award.event_instance_id || null,
      projectId: award.project_id || null,
      source: award.source || null,
      reason
    }
  }));
  return { award, revoked: true, alreadyRevoked: false, auditEvent };
}

export async function listPersonBadges(db, personId) {
  const safePersonId = stringOrNull(personId);
  if (!safePersonId) throw Object.assign(new Error("personId is required"), { status: 400 });
  const result = await db.prepare(`
    SELECT
      ub.id AS award_id,
      ub.id,
      ub.user_id,
      ub.badge_id,
      ub.event_instance_id,
      ub.project_id,
      ub.source,
      ub.awarded_by,
      ub.awarded_at,
      ub.created_at,
      ub.revoked_at,
      ub.revoked_by,
      ub.revoke_reason,
      b.slug,
      b.name,
      b.description,
      b.badge_type,
      b.rule_json
    FROM user_badges ub
    JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ?
      AND ub.revoked_at IS NULL
    ORDER BY ub.awarded_at DESC, ub.created_at DESC, ub.id ASC
  `).bind(safePersonId).all();
  return (result.results || []).map(decorateBadge);
}

export async function deriveBadgesForPerson(db, personId, options = {}) {
  const safePersonId = stringOrNull(personId);
  if (!safePersonId) throw Object.assign(new Error("personId is required"), { status: 400 });
  const dryRun = options.dryRun ?? options.dry_run ?? true;
  const facts = await loadBadgeDerivationFacts(db, safePersonId);
  const derived = dedupeBadges(deriveBadgesFromFacts(facts));
  const existing = await listPersonBadges(db, safePersonId);
  const existingSlugs = new Set(existing.map((badge) => badge.slug));
  const missing = derived.filter((badge) => !existingSlugs.has(badge.slug));
  const plan = {
    personId: safePersonId,
    dryRun: Boolean(dryRun),
    derived,
    existing,
    missing,
    wouldAward: missing.map(({ slug, event_instance_id, project_id, source, awarded_at }) => ({
      personId: safePersonId,
      badgeSlug: slug,
      eventInstanceId: event_instance_id,
      projectId: project_id,
      source,
      awardedAt: awarded_at
    })),
    awards: []
  };
  if (dryRun) return plan;

  for (const badge of missing) {
    plan.awards.push(await awardBadge(db, {
      personId: safePersonId,
      badgeSlug: badge.slug,
      eventInstanceId: badge.event_instance_id,
      projectId: badge.project_id,
      source: badge.source || "derived"
    }));
  }
  return plan;
}

export function deriveBadgesFromFacts({ attendance = [], projects = [], projectAwards = [] } = {}) {
  const derived = [];
  const attendanceRows = attendance || [];
  const hasCheckedIn = (slug) => attendanceRows.some((event) => event.event_slug === slug && event.event_type === "checked_in");
  if (hasCheckedIn("hack-the-valley-2026")) {
    const event = attendanceRows.find((row) => row.event_slug === "hack-the-valley-2026" && row.event_type === "checked_in");
    derived.push(decorateBadge({ slug: "attended-htv-2026", event_instance_id: event?.event_instance_id, awarded_at: event?.occurred_at, source: "derived" }));
  }
  if (hasCheckedIn("hack-hours")) {
    const event = attendanceRows.find((row) => row.event_slug === "hack-hours" && row.event_type === "checked_in");
    derived.push(decorateBadge({ slug: "attended-hack-hours", event_instance_id: event?.event_instance_id, awarded_at: event?.occurred_at, source: "derived" }));
  }
  if (projects.length > 0) derived.push(decorateBadge({ slug: "submitted-project", project_id: projects[0]?.project_id, awarded_at: projects[0]?.submission_created_at || projects[0]?.created_at, source: "derived" }));
  if (projectAwards.length > 0) {
    const firstAward = projectAwards[0];
    derived.push(decorateBadge({ slug: "won-prize-htv-2026", project_id: firstAward.project_id, awarded_at: firstAward.awarded_at || firstAward.created_at, source: "derived" }));
  }
  const overall = projectAwards.find((award) => award.award_slug === "overall" || /overall/i.test(award.award_title || ""));
  if (overall) derived.push(decorateBadge({ slug: "won-overall-htv-2026", project_id: overall.project_id, awarded_at: overall.awarded_at || overall.created_at, source: "derived" }));
  return derived;
}

function toBadgeCatalogItem(row = {}) {
  const badge = decorateBadge(row);
  return {
    id: row.id || badge.id,
    slug: badge.slug,
    name: badge.name,
    description: badge.description,
    badge_type: badge.badge_type,
    rule: parseJsonObject(row.rule_json, null),
    active: row.active === undefined ? true : Boolean(row.active),
    icon_url: badge.icon_url,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

async function findBadgeAward(db, { personId, badgeId, eventInstanceId = null, includeRevoked = false, onlyRevoked = false } = {}) {
  const revokedFilter = onlyRevoked
    ? "AND ub.revoked_at IS NOT NULL"
    : includeRevoked
      ? ""
      : "AND ub.revoked_at IS NULL";
  return await db.prepare(`
    SELECT ub.*, b.slug, b.name, b.description, b.badge_type
    FROM user_badges ub
    JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ?
      AND ub.badge_id = ?
      AND ((ub.event_instance_id IS NULL AND ? IS NULL) OR ub.event_instance_id = ?)
      ${revokedFilter}
    ORDER BY ub.awarded_at ASC, ub.created_at ASC, ub.id ASC
    LIMIT 1
  `).bind(personId, badgeId, eventInstanceId, eventInstanceId).first();
}

async function selectBadgeAwardById(db, awardId) {
  return await db.prepare(`
    SELECT ub.*, b.slug, b.name, b.description, b.badge_type
    FROM user_badges ub
    JOIN badges b ON b.id = ub.badge_id
    WHERE ub.id = ?
    LIMIT 1
  `).bind(awardId).first();
}

function badgeAwardId({ personId, badgeId, eventInstanceId = null, projectId = null } = {}) {
  const context = eventInstanceId || projectId || "global";
  return `ubg_${personId}_${badgeId}_${context}`.replace(/[^a-zA-Z0-9_]+/g, "_");
}

async function appendBadgeAwardAudit(db, { award, badge, source, actorUserId, reactivated = false } = {}) {
  if (!shouldAuditAward({ source, actorUserId })) return null;
  return await appendAuditEvent(db, buildAuditEvent({
    action: "badge.award",
    actorUserId,
    targetType: "badge_award",
    targetId: award.id,
    metadata: {
      personId: award.user_id,
      badgeId: badge.id,
      badgeSlug: badge.slug,
      eventInstanceId: award.event_instance_id || null,
      projectId: award.project_id || null,
      source,
      reactivated
    }
  }));
}

function shouldAuditAward({ source, actorUserId } = {}) {
  const normalizedSource = String(source || "").trim().toLowerCase();
  return Boolean(actorUserId || normalizedSource === "admin" || normalizedSource === "manual_admin" || normalizedSource === "bootstrap_admin");
}

function firstBadgeRouteValue(...values) {
  for (const value of values) {
    const normalized = stringOrNull(value);
    if (normalized) return normalized;
  }
  return null;
}

function queryValue(query, name) {
  if (!query) return null;
  if (typeof query.get === "function") return query.get(name);
  return query[name];
}

async function loadBadgeDerivationFacts(db, personId) {
  const user = await db.prepare("SELECT id, email FROM users WHERE id = ?").bind(personId).first();
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  const [attendance, projects, projectAwards] = await Promise.all([
    db.prepare(`
      SELECT event_slug, event_instance_id, signup_id, event_type, actor, source, occurred_at
      FROM event_participant_events
      WHERE user_id = ?
      ORDER BY occurred_at DESC
      LIMIT 100
    `).bind(personId).all(),
    db.prepare(`
      SELECT p.id AS project_id, p.slug, p.title, p.team_name, p.description, p.repo_url, p.demo_url,
             p.canonical_submission_id, cs.payload_json, cs.uploads_json,
             eps.event_slug, eps.event_instance_id, eps.submission_id, COALESCE(eps.status, pm.role) AS status,
             eps.created_at AS submission_created_at,
             p.created_at
      FROM project_members pm
      JOIN projects p ON p.id = pm.project_id
      LEFT JOIN submissions cs ON cs.id = p.canonical_submission_id
      LEFT JOIN event_project_submissions eps ON eps.project_id = p.id AND eps.status != 'hidden'
      WHERE (pm.user_id = ? OR lower(pm.email) = lower(?))
      ORDER BY lower(p.title) ASC
    `).bind(personId, user.email || "").all(),
    db.prepare(`
      SELECT DISTINCT epa.event_slug, epa.project_id, epa.award_slug, epa.award_title, epa.created_at AS awarded_at
      FROM project_members pm
      JOIN event_project_awards epa ON epa.project_id = pm.project_id
      WHERE epa.event_slug = 'hack-the-valley-2026'
        AND (pm.user_id = ? OR lower(pm.email) = lower(?))
      ORDER BY CASE WHEN epa.award_slug = 'overall' THEN 0 ELSE 1 END, epa.award_rank ASC, epa.award_title ASC
    `).bind(personId, user.email || "").all()
  ]);
  return {
    attendance: attendance.results || [],
    projects: projects.results || [],
    projectAwards: projectAwards.results || []
  };
}

function stringifyJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
