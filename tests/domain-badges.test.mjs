import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  awardBadge,
  awardPersonBadgeFromAdminRoute,
  deriveBadgesForPerson,
  listBadgeCatalog,
  listPersonBadges,
  revokeBadgeAward,
  revokePersonBadgeFromAdminRoute
} from "../functions/_lib/domain/badges.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

function createBadgeDb(seed = {}) {
  const state = {
    badges: [...(seed.badges || [{ id: "bdg_shared_demo", slug: "shared-demo", name: "Shared a Demo", description: "Shared a project or demo with the community.", badge_type: "demo", active: 1 }])],
    awards: [...(seed.awards || [])],
    audits: [],
    user: seed.user || { id: "usr_maya", email: "maya@example.com" },
    attendance: seed.attendance || [],
    projects: seed.projects || [],
    projectAwards: seed.projectAwards || [],
    calls: []
  };

  function joinedAward(award) {
    if (!award) return null;
    const badge = state.badges.find((row) => row.id === award.badge_id) || {};
    return { ...award, slug: badge.slug, name: badge.name, description: badge.description, badge_type: badge.badge_type };
  }

  function awardMatchesContext(award, [personId, badgeId, eventA, eventB]) {
    const eventMatches = (award.event_instance_id === null && eventA === null) || award.event_instance_id === eventB;
    return award.user_id === personId && award.badge_id === badgeId && eventMatches;
  }

  return {
    state,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async run() {
          state.calls.push({ method: "run", sql, args: this.args });
          if (/INSERT INTO badges/.test(sql)) {
            const [id, slug, name, description, badgeType, ruleJson, createdAt, updatedAt] = this.args;
            const existing = state.badges.find((badge) => badge.slug === slug);
            if (existing) {
              Object.assign(existing, { name: name || existing.name, description, badge_type: badgeType || existing.badge_type, rule_json: ruleJson, active: 1, updated_at: updatedAt });
            } else {
              state.badges.push({ id, slug, name, description, badge_type: badgeType, rule_json: ruleJson, active: 1, created_at: createdAt, updated_at: updatedAt });
            }
          } else if (/INSERT OR IGNORE INTO user_badges/.test(sql)) {
            const [id, userId, badgeId, eventInstanceId, projectId, source, awardedBy, awardedAt, createdAt] = this.args;
            if (!state.awards.some((award) => award.id === id)) {
              state.awards.push({ id, user_id: userId, badge_id: badgeId, event_instance_id: eventInstanceId, project_id: projectId, source, awarded_by: awardedBy, awarded_at: awardedAt, created_at: createdAt, revoked_at: null, revoked_by: null, revoke_reason: null });
            }
          } else if (/SET revoked_at = \?/.test(sql)) {
            const [revokedAt, revokedBy, reason, id] = this.args;
            const award = state.awards.find((row) => row.id === id && !row.revoked_at);
            if (award) Object.assign(award, { revoked_at: revokedAt, revoked_by: revokedBy, revoke_reason: reason });
          } else if (/SET project_id = \?/.test(sql)) {
            const [projectId, source, awardedBy, awardedAt, id] = this.args;
            const award = state.awards.find((row) => row.id === id);
            if (award) Object.assign(award, { project_id: projectId, source, awarded_by: awardedBy, awarded_at: awardedAt, revoked_at: null, revoked_by: null, revoke_reason: null });
          } else if (/INSERT INTO audit_events/.test(sql)) {
            state.audits.push({ args: this.args, metadata: JSON.parse(this.args[7]) });
          } else if (/INSERT INTO admin_audit_events/.test(sql)) {
            state.audits.push({ args: this.args, metadata: JSON.parse(this.args[8]) });
          }
          return { success: true };
        },
        async first() {
          state.calls.push({ method: "first", sql, args: this.args });
          if (/SELECT \* FROM badges WHERE slug = \?/.test(sql)) {
            return state.badges.find((badge) => badge.slug === this.args[0]) || null;
          }
          if (/FROM users WHERE id = \?/.test(sql)) {
            return this.args[0] === state.user.id ? state.user : null;
          }
          if (/WHERE ub\.id = \?/.test(sql)) {
            return joinedAward(state.awards.find((award) => award.id === this.args[0]));
          }
          if (/FROM user_badges ub\s+JOIN badges b/.test(sql)) {
            let candidates = state.awards.filter((award) => awardMatchesContext(award, this.args));
            if (/ub\.revoked_at IS NOT NULL/.test(sql)) candidates = candidates.filter((award) => award.revoked_at);
            if (/ub\.revoked_at IS NULL/.test(sql)) candidates = candidates.filter((award) => !award.revoked_at);
            return joinedAward(candidates[0]) || null;
          }
          return null;
        },
        async all() {
          state.calls.push({ method: "all", sql, args: this.args });
          if (/FROM badges/.test(sql) && !/JOIN badges/.test(sql)) {
            let rows = state.badges;
            if (/active = 1/.test(sql)) rows = rows.filter((badge) => Number(badge.active) === 1);
            if (/badge_type = \?/.test(sql)) rows = rows.filter((badge) => badge.badge_type === this.args[0]);
            return { results: rows };
          }
          if (/FROM event_participant_events/.test(sql)) return { results: state.attendance };
          if (/FROM project_members pm\s+JOIN projects/.test(sql)) return { results: state.projects };
          if (/FROM user_badges ub\s+JOIN badges b/.test(sql)) {
            return { results: state.awards.filter((award) => award.user_id === this.args[0] && !award.revoked_at).map(joinedAward) };
          }
          if (/FROM project_members pm\s+JOIN event_project_awards/.test(sql)) return { results: state.projectAwards };
          return { results: [] };
        }
      };
      return statement;
    }
  };
}

test("listBadgeCatalog returns active decorated badge metadata", async () => {
  const { state, ...db } = createBadgeDb({ badges: [
    { id: "bdg_a", slug: "alpha", name: "Alpha", description: null, badge_type: "community", active: 1 },
    { id: "bdg_z", slug: "zzz", name: "Retired", description: null, badge_type: "community", active: 0 }
  ] });

  const catalog = await listBadgeCatalog(db, { type: "community" });

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].slug, "alpha");
  assert.equal(catalog[0].icon_url, "/images/badges/alpha.svg");
  assert.ok(state.calls.some((call) => /active = 1/.test(call.sql) && /badge_type = \?/.test(call.sql)));
});

test("awardBadge writes admin audit provenance for new awards and returns deterministic duplicates", async () => {
  const db = createBadgeDb();

  const first = await awardBadge(db, {
    personId: "usr_maya",
    badgeSlug: "shared-demo",
    eventInstanceId: "inst_1",
    source: "admin",
    awardedBy: "usr_admin"
  });
  const second = await awardBadge(db, {
    personId: "usr_maya",
    badgeSlug: "shared-demo",
    eventInstanceId: "inst_1",
    source: "admin",
    awardedBy: "usr_admin"
  });

  assert.equal(first.created, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.award.id, "ubg_usr_maya_bdg_shared_demo_inst_1");
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.award.id, first.award.id);
  assert.equal(db.state.awards.length, 1);
  assert.equal(db.state.audits.length, 1);
  assert.equal(db.state.audits[0].args[1], "badge.award");
  assert.equal(db.state.audits[0].metadata.badgeSlug, "shared-demo");
});

test("revokeBadgeAward marks awards revoked and writes audit provenance", async () => {
  const db = createBadgeDb({
    awards: [{ id: "ubg_1", user_id: "usr_maya", badge_id: "bdg_shared_demo", event_instance_id: "inst_1", project_id: null, source: "admin", awarded_by: "usr_admin", awarded_at: "2026-06-23T12:00:00.000Z", created_at: "2026-06-23T12:00:00.000Z", revoked_at: null }]
  });

  const result = await revokeBadgeAward(db, { awardId: "ubg_1", actorUserId: "usr_admin", reason: "mistaken award" });
  const visible = await listPersonBadges(db, "usr_maya");

  assert.equal(result.revoked, true);
  assert.equal(result.award.revoked_by, "usr_admin");
  assert.equal(result.award.revoke_reason, "mistaken award");
  assert.deepEqual(visible, []);
  assert.equal(db.state.audits.length, 1);
  assert.equal(db.state.audits[0].args[1], "badge.revoke");
  assert.equal(db.state.audits[0].metadata.reason, "mistaken award");
});

test("admin badge route boundary preserves response shape and ignores forged body provenance", async () => {
  const db = createBadgeDb();

  const awarded = await awardPersonBadgeFromAdminRoute(db, {
    personId: "usr_maya",
    access: { user: { id: "usr_admin" }, role: { role: "admin" }, bootstrap: false },
    input: {
      badge_slug: "shared-demo",
      event_instance_id: "inst_route",
      source: "derived",
      awarded_by: "usr_forged",
      actorUserId: "usr_forged"
    }
  });

  assert.equal(awarded.badge.slug, "shared-demo");
  assert.equal(awarded.award.source, "admin");
  assert.equal(awarded.award.awarded_by, "usr_admin");
  assert.equal(awarded.created, true);
  assert.equal(awarded.duplicate, false);
  assert.equal(awarded.reactivated, false);
  assert.ok(Object.hasOwn(awarded, "auditEvent"));
  assert.equal(db.state.audits[0].metadata.source, "admin");

  const revoked = await revokePersonBadgeFromAdminRoute(db, {
    access: { user: { id: "usr_admin" }, role: { role: "admin" }, bootstrap: false },
    input: {
      award_id: awarded.award.id,
      reason: "route correction",
      revoked_by: "usr_forged",
      actorUserId: "usr_forged"
    },
    query: new URLSearchParams("award_id=ubg_other&reason=query-reason")
  });

  assert.equal(revoked.revoked, true);
  assert.equal(revoked.alreadyRevoked, false);
  assert.equal(revoked.award.revoked_by, "usr_admin");
  assert.equal(revoked.award.revoke_reason, "route correction");
  assert.ok(Object.hasOwn(revoked, "auditEvent"));
  assert.equal(db.state.audits[1].metadata.reason, "route correction");
});

test("badge route strangler stays scoped to Badges domain without content or email lanes", () => {
  const route = read("functions/api/users/[id]/badges.js");

  assert.match(route, /domain\/badges\.js/);
  assert.doesNotMatch(route, /blog|campaign|broadcast|follow[-_]?up|email\s+blast|content\s+item/i);
});

test("deriveBadgesForPerson defaults to dry-run and reports missing awards without writes", async () => {
  const db = createBadgeDb({
    attendance: [
      { event_slug: "hack-the-valley-2026", event_instance_id: "inst_htv", event_type: "checked_in", occurred_at: "2026-05-30T16:00:00.000Z" },
      { event_slug: "hack-hours", event_instance_id: "inst_hh", event_type: "checked_in", occurred_at: "2026-06-20T16:00:00.000Z" }
    ],
    projects: [{ project_id: "prj_1", slug: "demo", title: "Demo", submission_created_at: "2026-05-31T00:00:00.000Z" }],
    projectAwards: [{ event_slug: "hack-the-valley-2026", project_id: "prj_1", award_slug: "overall", award_title: "Overall Winner", awarded_at: "2026-05-31T01:00:00.000Z" }]
  });

  const plan = await deriveBadgesForPerson(db, "usr_maya");

  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.wouldAward.map((award) => award.badgeSlug), [
    "attended-htv-2026",
    "attended-hack-hours",
    "submitted-project",
    "won-prize-htv-2026",
    "won-overall-htv-2026"
  ]);
  assert.equal(db.state.awards.length, 0);
  assert.equal(db.state.calls.some((call) => call.method === "run" && /INSERT OR IGNORE INTO user_badges/.test(call.sql)), false);
});
