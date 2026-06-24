import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  awardBadge,
  checkInAttendee,
  claimProjectForUser,
  submitOwnedProjectToEvent,
  updateEventProjectSubmissionStatus,
  updateOwnedProjectForUser,
  countEventPhotos,
  createEventPhotoRecord,
  getEventCockpit,
  getCurrentUserFromSession,
  getEventFollowupPacket,
  getUserCommunityState,
  getPublicProjectHeroMedia,
  linkProjectSubmission,
  listSignups,
  listEventPhotos,
  listEventProjectSubmissions,
  listPublicProjects,
  normalizeEmergencyContactInput,
  normalizeProjectInput,
  normalizeSignupInput,
  requestLoginCode,
  renderEventPageHtml,
  requireOrganizerAccess,
  requireSuperAdminAccess,
  upsertEmergencyContact,
  upsertProjectFromSubmission,
  upsertSignup,
  verifyLoginCode,
  verifyLoginToken
} from "../functions/_lib/event-platform.js";
import worker from "../worker.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const adminHeaders = (extra = {}) => ({ cookie: "htv_session=test-session", ...extra });

function withAdminRoleDb(db, { role = "admin" } = {}) {
  return {
    prepare(sql) {
      if (/FROM user_sessions/.test(sql)) {
        return {
          bind(...args) { this.args = args; return this; },
          async first() {
            return { id: "usr_admin", email: "admin@example.com", session_id: "ses_admin", session_expires_at: "2099-01-01T00:00:00.000Z" };
          },
          async all() { return { results: [] }; },
          async run() { return { success: true }; }
        };
      }
      if (/FROM roles/.test(sql)) {
        return {
          bind(...args) { this.args = args; return this; },
          async first() {
            return role && this.args.includes(role) ? { role, scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" } : null;
          },
          async all() { return { results: role ? [{ role, scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" }] : [] }; },
          async run() { return { success: true }; }
        };
      }
      return db.prepare(sql);
    }
  };
}

test("participant login page requests a code, verifies it, and reads /api/me", () => {
  const html = read("public/login/index.html");
  assert.match(html, /id="login-request-form"/);
  assert.match(html, /id="login-verify-form"/);
  assert.match(html, /magic link/i);
  assert.match(html, /\/api\/auth\/request-code/);
  assert.match(html, /\/api\/auth\/verify-code/);
  assert.match(html, /\/api\/me/);
  assert.match(html, /Check your email/);
  assert.match(html, /nextPath/);
  assert.match(html, /next: nextPath/);
  assert.match(html, /window\.location\.href = nextPath/);
  assert.doesNotMatch(html, /admin password|HTV_ADMIN_TOKEN/i);
});

test("homepage exposes clear participant account CTAs", () => {
  const html = read("public/index.html");
  assert.match(html, /data-nav-link="profile" href="\/login\/\?next=\/me\/"[^>]*>Profile</);
  assert.match(html, /href="\/login\/\?next=\/me\/projects\//);
  assert.match(html, /Open your profile and projects/);
});

test("participant profile shows editable profile info, badges, and project summary from /api/me", () => {
  const html = read("public/me/index.html");
  assert.match(html, /id="participant-profile"/);
  assert.match(html, /id="profile-card"/);
  assert.match(html, /id="profile-edit-form"/);
  assert.match(html, /\/api\/me/);
  assert.match(html, /fetch\("\/api\/me"/);
  assert.match(html, /encodeURIComponent\(window\.location\.pathname \+ window\.location\.search\)/);
  assert.doesNotMatch(html, /API_ORIGIN\s*=\s*'https:\/\/hack-the-valley\.pages\.dev'/);
  assert.match(html, /method: "PATCH"/);
  assert.match(html, /id="attendance-list"/);
  assert.match(html, /id="project-summary-list"/);
  assert.match(html, /id="badge-list"/);
  assert.match(html, /\/me\/projects\//);
  assert.match(html, /\/login\//);
  assert.match(html, /Manage your project workspace/);
  assert.match(html, /Emergency contact/);
  assert.match(html, /Private event-safety details/);
  assert.match(html, /id="emergency-contact-fields"/);
  assert.match(html, /data-emergency-contact/);
  assert.match(html, /emergency_contacts/);
  assert.match(html, /Badges/);
  assert.match(html, /badge\.icon_url/);
  assert.match(html, /\/images\/badges\//);
  assert.doesNotMatch(html, /id="project-create-form"/);
  assert.doesNotMatch(html, /Showcase event slug|name="event_slug"/);
  assert.doesNotMatch(html, /HTV_ADMIN_TOKEN|data-award-badge/i);
});

test("participant projects workspace lets signed-in users create, edit, upload, and submit projects", () => {
  const html = read("public/me/projects/index.html");
  assert.match(html, /id="participant-projects"/);
  assert.match(html, /id="project-create-form"/);
  assert.match(html, /name="title"/);
  assert.match(html, /name="repo_url"/);
  assert.match(html, /name="demo_url"/);
  assert.match(html, /\/api\/me\/projects/);
  assert.match(html, /\/api\/upload/);
  assert.match(html, /fetch\("\/api\/me"/);
  assert.match(html, /encodeURIComponent\(window\.location\.pathname \+ window\.location\.search\)/);
  assert.match(html, /const url = `\/api\/upload/);
  assert.doesNotMatch(html, /API_ORIGIN\s*=\s*'https:\/\/hack-the-valley\.pages\.dev'/);
  assert.match(html, /\/materials/);
  assert.match(html, /data-project-upload/);
  assert.match(html, /Add project/);
  assert.match(html, /data-project-edit-form/);
  assert.match(html, /Submit to Hack the Valley/);
  assert.doesNotMatch(html, /Showcase event slug|name="event_slug"/);
  assert.doesNotMatch(html, /admin password|data-award-badge|HTV_ADMIN_TOKEN/i);
});

test("event pages can launch contextual project submission without raw event slug fields", () => {
  const eventHtml = read("public/events/hack-the-valley-2026/index.html");
  const projectsHtml = read("public/me/projects/index.html");
  assert.match(eventHtml, /Submit a project for this event/);
  assert.match(eventHtml, /\/me\/projects\/\?event=hack-the-valley-2026&eventName=Hack%20the%20Valley%202026/);
  assert.match(projectsHtml, /id="event-context-banner"/);
  assert.match(projectsHtml, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(projectsHtml, /payload\.event_slug = eventContext\.slug/);
  assert.match(projectsHtml, /Submit to \$\{escapeHtml\(submitLabel\)\}/);
  assert.match(projectsHtml, /login\/\?next=\$\{encodeURIComponent\(window\.location\.pathname \+ window\.location\.search\)\}/);
  assert.doesNotMatch(projectsHtml, /name="event_slug"|Showcase event slug/);
});

test("legacy submit paths redirect to the project workspace", async () => {
  for (const path of ["/submit", "/submit/"]) {
    const response = await worker.fetch(new Request(`https://hackthevalley.org${path}`), {}, {});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://hackthevalley.org/me/projects/");
  }
});

test("claimProjectForUser creates a project and records owner membership", async () => {
  const statements = [];
  let insertedProject = false;
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() {
          if (/INSERT INTO projects/.test(sql)) insertedProject = true;
          return { success: true };
        },
        async first() {
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM projects/.test(sql)) return insertedProject ? { id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Valley SAT Prep" } : null;
          return null;
        },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };

  const result = await claimProjectForUser(db, "usr_maya", {
    title: "Valley SAT Prep",
    team_name: "Sequoia Sasquatches",
    repo_url: "https://github.com/example/sat"
  });
  assert.equal(result.project.slug, "valley-sat-prep");
  assert.equal(result.membership.role, "owner");
  const sql = statements.map((s) => s.sql).join("\n");
  assert.match(sql, /INSERT INTO projects/);
  assert.match(sql, /INSERT INTO project_members/);
  assert.ok(statements.some((s) => s.args.includes("usr_maya") && s.args.includes("owner")));
});

test("owned project helpers require ownership before editing or submitting", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM projects p/.test(sql) && /project_members pm/.test(sql)) return { id: "prj_1", slug: "old", title: "Old", team_name: "Old Team" };
          if (/SELECT \* FROM projects/.test(sql)) return { id: "prj_1", slug: "old", title: "Edited Project", team_name: "New Team" };
          return null;
        },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };

  const updated = await updateOwnedProjectForUser(db, "usr_maya", "prj_1", { title: "Edited Project", team_name: "New Team" });
  assert.equal(updated.project.title, "Edited Project");
  assert.match(statements.map((s) => s.sql).join("\n"), /UPDATE projects/);
  assert.ok(statements.some((s) => s.args.includes("usr_maya") && s.args.includes("prj_1")));

  const submitted = await submitOwnedProjectToEvent(db, "usr_maya", "prj_1", { event_slug: "hack-the-valley-2026" });
  assert.equal(submitted.submission.status, "submitted");
  assert.equal(submitted.submission.source, "participant_dashboard");
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO event_project_submissions/);
});

test("participant submit cannot restore an organizer-hidden event project", async () => {
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM projects p/.test(sql) && /project_members pm/.test(sql)) return { id: "prj_hidden", slug: "hidden", title: "Hidden Smoke" };
          if (/FROM event_project_submissions/.test(sql)) return { id: "eps_hidden", status: "hidden" };
          return null;
        },
        async all() { return { results: [] }; }
      };
    }
  };
  await assert.rejects(
    () => submitOwnedProjectToEvent(db, "usr_maya", "prj_hidden", { event_slug: "hack-the-valley-2026" }),
    /closed by an organizer/
  );
});

test("owned project helpers reject edits when the user is not a project member", async () => {
  const db = { prepare(sql) { return { bind() { return this; }, async first() { return /FROM users/.test(sql) ? { id: "usr_intruder", email: "intruder@example.com" } : null; }, async run() { return {}; } }; } };
  await assert.rejects(
    () => updateOwnedProjectForUser(db, "usr_intruder", "prj_1", { title: "Nope" }),
    /Project not found/
  );
});

test("admin cleanup can hide or restore an event-linked project without deleting records", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async first() {
          if (/FROM event_project_submissions eps/.test(sql)) {
            return { event_slug: "hack-the-valley-2026", project_id: "prj_smoke", status: "submitted", title: "Smoke" };
          }
          return null;
        },
        async run() { return { success: true }; }
      };
      return statement;
    }
  };
  const hidden = await updateEventProjectSubmissionStatus(db, { eventSlug: "hack-the-valley-2026", projectId: "prj_smoke", status: "hidden" });
  assert.equal(hidden.status, "hidden");
  assert.match(statements.map((s) => s.sql).join("\n"), /UPDATE event_project_submissions/);
  assert.ok(statements.some((s) => s.args.includes("hidden") && s.args.includes("prj_smoke")));
  await assert.rejects(
    () => updateEventProjectSubmissionStatus(db, { eventSlug: "hack-the-valley-2026", projectId: "prj_smoke", status: "delete" }),
    /Unsupported project submission status/
  );
});

test("/api/me lets the signed-in user update basic profile info", async () => {
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM user_sessions us/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R.", session_id: "ses_1", session_expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya Rivera", first_name: "Maya", last_name: "Rivera", phone: "661-555-0100", school: "CSUB" };
          return null;
        },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };

  const response = await worker.fetch(new Request("https://hackthevalley.org/api/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: "htv_session=test-session-token" },
    body: JSON.stringify({ first_name: "Maya", last_name: "Rivera", phone: "661-555-0100", school: "CSUB" })
  }), { HTV_DB: fakeDb }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.first_name, "Maya");
  assert.equal(body.user.school, "CSUB");
  assert.match(statements.map((s) => s.sql).join("\n"), /UPDATE users/);
});

test("/api/me lets the signed-in user update private emergency contact info for their event signups", async () => {
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM user_sessions us/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R.", session_id: "ses_1", session_expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya Rivera", first_name: "Maya", last_name: "Rivera", phone: "661-555-0100", school: "CSUB" };
          if (/FROM emergency_contacts/.test(sql)) return { id: "emc_maya", event_instance_id: "inst_hack_hours_20260620", user_id: "usr_maya", signup_id: "sgn_maya", name: "Aunt Elena", relationship: "Aunt", phone: "661-555-0199", source: "profile" };
          return null;
        },
        async all() {
          if (/FROM signups\s+WHERE user_id/.test(sql)) return { results: [{ id: "sgn_maya", event_instance_id: "inst_hack_hours_20260620" }] };
          if (/FROM signups s\s+JOIN events e/.test(sql)) return { results: [{ event_slug: "hack-hours", event_title: "Hack Hours", event_instance_id: "inst_hack_hours_20260620", signup_id: "sgn_maya", instance_key: "2026-06-20", name: "Aunt Elena", relationship: "Aunt", phone: "661-555-0199", source: "profile", present: 1 }] };
          return { results: [] };
        }
      };
      return statement;
    }
  };

  const response = await worker.fetch(new Request("https://hackthevalley.org/api/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: "htv_session=test-session-token" },
    body: JSON.stringify({
      first_name: "Maya",
      last_name: "Rivera",
      emergency_contacts: [{
        event_instance_id: "inst_hack_hours_20260620",
        name: "Aunt Elena",
        relationship: "Aunt",
        phone: "661-555-0199"
      }]
    })
  }), { HTV_DB: fakeDb }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.emergency_contacts[0].name, "Aunt Elena");
  assert.equal(body.emergency_contacts[0].present, true);
  const sql = statements.map((s) => s.sql).join("\n");
  assert.match(sql, /SELECT id, event_instance_id\s+FROM signups/);
  assert.match(sql, /INSERT INTO emergency_contacts/);
  const contactWrite = statements.find((s) => /INSERT INTO emergency_contacts/.test(s.sql));
  assert.ok(contactWrite.args.includes("inst_hack_hours_20260620"));
  assert.ok(contactWrite.args.includes("usr_maya"));
  assert.ok(contactWrite.args.includes("profile"));
});

test("/api/me rejects emergency contact updates for event instances the participant does not own before profile writes", async () => {
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { statements.push({ sql, args }); this.args = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM user_sessions us/.test(sql)) return { id: "usr_maya", email: "maya@example.com", session_id: "ses_1", session_expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya" };
          return null;
        },
        async all() {
          if (/FROM signups\s+WHERE user_id/.test(sql)) return { results: [{ id: "sgn_maya", event_instance_id: "inst_owned" }] };
          return { results: [] };
        }
      };
    }
  };
  const response = await worker.fetch(new Request("https://hackthevalley.org/api/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: "htv_session=test-session-token" },
    body: JSON.stringify({ emergency_contacts: [{ event_instance_id: "inst_someone_else", name: "Nope", phone: "661-555-0199" }] })
  }), { HTV_DB: fakeDb }, {});
  assert.equal(response.status, 403);
  assert.match(await response.text(), /own event signups/);
  assert.equal(statements.some((statement) => /UPDATE users/.test(statement.sql)), false);
  assert.equal(statements.some((statement) => /INSERT INTO emergency_contacts/.test(statement.sql)), false);
});

test("authorized event signup exports include the latest emergency contact details", async () => {
  const db = {
    prepare(sql) {
      assert.match(sql, /LEFT JOIN emergency_contacts ec/);
      assert.match(sql, /emergency_contact_name/);
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          assert.deepEqual(this.args, ["hack-hours", "inst_hack_hours_20260620"]);
          return { results: [{
            id: "sgn_maya",
            event_slug: "hack-hours",
            event_instance_id: "inst_hack_hours_20260620",
            user_id: "usr_maya",
            email: "maya@example.com",
            name: "Maya Rivera",
            emergency_contact_present: 1,
            emergency_contact_name: "Aunt Elena",
            emergency_contact_relationship: "Aunt",
            emergency_contact_phone: "661-555-0199",
            emergency_contact_source: "profile"
          }] };
        }
      };
    }
  };
  const signups = await listSignups(db, "hack-hours", { eventInstanceId: "inst_hack_hours_20260620" });
  assert.equal(signups[0].emergency_contact_name, "Aunt Elena");
  assert.equal(signups[0].emergency_contact_source, "profile");
});

test("public project and leaderboard surfaces still omit emergency contact details", () => {
  const projectsSource = read("functions/api/projects.js");
  const leaderboardSource = read("functions/api/leaderboard.js");
  const platformSource = read("functions/_lib/event-platform.js");
  assert.doesNotMatch(projectsSource, /emergency_contacts|emergency_contact_name|emergency_contact_phone/);
  assert.match(platformSource, /function sanitizePublicProjectRow/);
  assert.match(leaderboardSource, /privacy: "Public leaderboard fields intentionally omit email, phone, emergency contact/);
});

test("/api/me/projects can create a project and associate it with an event context", async () => {
  const statements = [];
  let insertedProject = false;
  const fakeDb = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() {
          if (/INSERT INTO projects/.test(sql)) insertedProject = true;
          return { success: true };
        },
        async first() {
          if (/FROM user_sessions us/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R.", session_id: "ses_1", session_expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM projects/.test(sql)) return insertedProject ? { id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Valley SAT Prep" } : null;
          return null;
        },
        async all() {
          if (/FROM project_members/.test(sql)) return { results: [{ project_id: "prj_valley_sat_prep", title: "Valley SAT Prep", event_slug: null, status: "owner" }] };
          return { results: [] };
        }
      };
      return statement;
    }
  };

  const response = await worker.fetch(new Request("https://hackthevalley.org/api/me/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "htv_session=test-session-token" },
    body: JSON.stringify({ title: "Valley SAT Prep", team_name: "Sequoia Sasquatches", event_slug: "hack-the-valley-2026" })
  }), { HTV_DB: fakeDb }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.project.title, "Valley SAT Prep");
  assert.equal(body.submission.status, "submitted");
  assert.equal(body.submission.event_slug, "hack-the-valley-2026");
  assert.equal(body.state.user.email, "maya@example.com");
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO project_members/);
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO event_project_submissions/);
});

test("/api/me/projects/<id> supports owner edit and event submission", async () => {
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM user_sessions us/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R.", session_id: "ses_1", session_expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM projects p/.test(sql) && /project_members pm/.test(sql)) return { id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Valley SAT Prep" };
          if (/SELECT \* FROM projects/.test(sql)) return { id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Edited Valley SAT Prep" };
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          return null;
        },
        async all() {
          if (/FROM project_members/.test(sql)) return { results: [{ project_id: "prj_valley_sat_prep", title: "Edited Valley SAT Prep", event_slug: "hack-the-valley-2026", status: "submitted" }] };
          return { results: [] };
        }
      };
      return statement;
    }
  };

  const editResponse = await worker.fetch(new Request("https://hackthevalley.org/api/me/projects/prj_valley_sat_prep", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: "htv_session=test-session-token" },
    body: JSON.stringify({ title: "Edited Valley SAT Prep" })
  }), { HTV_DB: fakeDb }, {});
  assert.equal(editResponse.status, 200);
  assert.equal((await editResponse.json()).project.title, "Edited Valley SAT Prep");

  const submitResponse = await worker.fetch(new Request("https://hackthevalley.org/api/me/projects/prj_valley_sat_prep/submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "htv_session=test-session-token" },
    body: JSON.stringify({ event_slug: "hack-the-valley-2026" })
  }), { HTV_DB: fakeDb }, {});
  assert.equal(submitResponse.status, 200);
  assert.equal((await submitResponse.json()).submission.status, "submitted");
  const sql = statements.map((s) => s.sql).join("\n");
  assert.match(sql, /UPDATE projects/);
  assert.match(sql, /INSERT INTO event_project_submissions/);
});

test("/api/me/projects/<id>/materials saves uploaded materials against the owned project", async () => {
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM user_sessions us/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R.", session_id: "ses_1", session_expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM projects p/.test(sql) && /project_members pm/.test(sql)) return { id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Valley SAT Prep", team_name: "Sequoia Sasquatches", description: "SAT helper", repo_url: "", demo_url: "", tracks_json: "[]", canonical_submission_id: "htv_old" };
          if (/SELECT \* FROM projects/.test(sql)) return { id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Valley SAT Prep", team_name: "Sequoia Sasquatches", description: "SAT helper", repo_url: "", demo_url: "", tracks_json: "[]", canonical_submission_id: "htv_old" };
          if (/FROM submissions WHERE id/.test(sql)) return { payload_json: JSON.stringify({ mediaLink: "https://loom.example.com/old-demo" }), uploads_json: JSON.stringify([{ key: "submissions/team/old.png", filename: "old.png", kind: "image" }]) };
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          return null;
        },
        async all() {
          if (/FROM project_members/.test(sql)) return { results: [{ project_id: "prj_valley_sat_prep", title: "Valley SAT Prep", team_name: "Sequoia Sasquatches", status: "owner", payload_json: JSON.stringify({ mediaLink: "https://loom.example.com/new-demo" }), uploads_json: JSON.stringify([{ key: "submissions/team/video.mp4", filename: "demo.mp4", kind: "video" }]) }] };
          return { results: [] };
        }
      };
      return statement;
    }
  };

  const response = await worker.fetch(new Request("https://hackthevalley.org/api/me/projects/prj_valley_sat_prep/materials", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "htv_session=test-session-token" },
    body: JSON.stringify({
      title: "Valley SAT Prep",
      team_name: "Sequoia Sasquatches",
      description: "SAT helper",
      mediaLink: "https://loom.example.com/new-demo",
      uploads: [{ key: "submissions/team/video.mp4", filename: "demo.mp4", kind: "video" }]
    })
  }), { HTV_DB: fakeDb, SUBMISSIONS_MEDIA: { put: async () => ({}) } }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.state.projects[0].has_uploads, true);
  assert.equal(body.state.projects[0].media_link, "https://loom.example.com/new-demo");
  const sql = statements.map((s) => s.sql).join("\n");
  assert.match(sql, /INSERT INTO submissions/);
  assert.match(sql, /canonical_submission_id/);
  assert.match(sql, /UPDATE event_project_submissions/);
  const insertedSubmission = statements.find((s) => /INSERT INTO submissions/.test(s.sql));
  const uploadsJson = insertedSubmission.args[7];
  assert.match(uploadsJson, /old\.png/);
  assert.match(uploadsJson, /demo\.mp4/);
});

test("schema and migrations add passwordless user login sessions without passwords", () => {
  const schema = read("schema.sql");
  const migration = read("migrations/0010_passwordless_login.sql");
  for (const text of [schema, migration]) {
    assert.match(text, /CREATE TABLE IF NOT EXISTS auth_login_codes/);
    assert.match(text, /code_hash TEXT NOT NULL/);
    assert.match(text, /expires_at TEXT NOT NULL/);
    assert.match(text, /consumed_at TEXT/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS user_sessions/);
    assert.match(text, /token_hash TEXT NOT NULL UNIQUE/);
    assert.match(text, /expires_at TEXT NOT NULL/);
    assert.doesNotMatch(text, /password_hash|oauth_secret|refresh_token/i);
  }
  const magicMigration = read("migrations/0011_magic_login_links.sql");
  for (const text of [schema, magicMigration]) {
    assert.match(text, /magic_token_hash TEXT/);
    assert.match(text, /idx_auth_login_codes_magic_token/);
  }
});

test("passwordless login creates a code, verifies it, and resolves current user from a session", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/SELECT \* FROM users WHERE email/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM auth_login_codes/.test(sql)) return { id: "alc_1", user_id: "usr_maya", code_hash: this.args[1], expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM user_sessions us/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R.", session_id: "ses_1", session_expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM user_sessions/.test(sql)) return { id: "ses_1", user_id: "usr_maya", expires_at: "2999-01-01T00:00:00.000Z" };
          return null;
        },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };

  const request = await requestLoginCode(db, { email: "MAYA@example.com", name: "Maya R." }, { HTV_AUTH_DEV_CODES: "1" });
  assert.equal(request.ok, true);
  assert.equal(request.email, "maya@example.com");
  assert.match(request.dev_code, /^\d{6}$/);
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO auth_login_codes/);
  assert.ok(statements.some((s) => s.args.includes("usr_maya")));

  const verified = await verifyLoginCode(db, { email: "maya@example.com", code: request.dev_code });
  assert.equal(verified.user.email, "maya@example.com");
  assert.match(verified.session.token, /^htvs_/);
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO user_sessions/);
  assert.match(statements.map((s) => s.sql).join("\n"), /UPDATE auth_login_codes/);

  const current = await getCurrentUserFromSession(db, verified.session.token);
  assert.equal(current.email, "maya@example.com");
});

test("magic login token creates a session and consumes the one-time login record", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM auth_login_codes alc/.test(sql)) {
            return {
              id: "alc_magic",
              user_id: "usr_maya",
              email: "maya@example.com",
              magic_token_hash: this.args[0],
              expires_at: "2999-01-01T00:00:00.000Z",
              user_email: "maya@example.com",
              user_name: "Maya R."
            };
          }
          if (/FROM users WHERE id/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          return null;
        },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };

  const verified = await verifyLoginToken(db, { token: "htvl_test_magic_token_123456789" });
  assert.equal(verified.user.email, "maya@example.com");
  assert.match(verified.session.token, /^htvs_/);
  assert.match(statements.map((s) => s.sql).join("\n"), /magic_token_hash/);
  assert.match(statements.map((s) => s.sql).join("\n"), /UPDATE auth_login_codes/);
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO user_sessions/);
});

test("passwordless login sends one-time codes through Resend when configured", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (/SELECT \* FROM users WHERE email/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          return null;
        },
        async all() { return { results: [] }; }
      };
    }
  };
  const fetcher = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const request = await requestLoginCode(db, { email: "maya@example.com", name: "Maya R.", code: "123456" }, {
    RESEND_API_KEY: "test_resend_key",
    HTV_LOGIN_FROM_EMAIL: "Hack the Valley <updates@hackthevalley.org>",
    HTV_PUBLIC_BASE_URL: "https://hackthevalley.org"
  }, fetcher);

  assert.equal(request.delivery, "email_sent");
  assert.equal(request.resend_email_id, "email_123");
  assert.equal(request.dev_code, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test_resend_key");
  assert.equal(calls[0].body.from, "Hack the Valley <updates@hackthevalley.org>");
  assert.deepEqual(calls[0].body.to, ["maya@example.com"]);
  assert.match(calls[0].body.subject, /login code/i);
  assert.match(calls[0].body.text, /https:\/\/hackthevalley\.org\/api\/auth\/magic-login\?token=htvl_/);
  assert.match(calls[0].body.html, /href="https:\/\/hackthevalley\.org\/api\/auth\/magic-login\?token=htvl_/);
  assert.match(calls[0].body.text, /123456/);
  assert.match(calls[0].body.html, /123456/);
  assert.equal(request.magic_login_url, undefined);
});

test("worker exposes passwordless auth request, verify, and /api/me", async () => {
  let lastSessionToken = null;
  const fakeDb = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (/SELECT \* FROM users WHERE email/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM auth_login_codes/.test(sql)) return { id: "alc_1", user_id: "usr_maya", code_hash: this.args[1], expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM user_sessions us/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R.", session_id: "ses_1", session_expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM user_sessions/.test(sql)) return { id: "ses_1", user_id: "usr_maya", expires_at: "2999-01-01T00:00:00.000Z" };
          return null;
        },
        async all() { return { results: [] }; }
      };
    }
  };

  const requestResponse = await worker.fetch(new Request("https://hackthevalley.org/api/auth/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "maya@example.com", name: "Maya R." })
  }), { HTV_DB: fakeDb, HTV_AUTH_DEV_CODES: "1" }, {});
  assert.equal(requestResponse.status, 200);
  const requested = await requestResponse.json();
  assert.match(requested.dev_code, /^\d{6}$/);

  const verifyResponse = await worker.fetch(new Request("https://hackthevalley.org/api/auth/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "maya@example.com", code: requested.dev_code })
  }), { HTV_DB: fakeDb }, {});
  assert.equal(verifyResponse.status, 200);
  const setCookie = verifyResponse.headers.get("set-cookie") || "";
  assert.match(setCookie, /htv_session=/);
  lastSessionToken = setCookie.match(/htv_session=([^;]+)/)?.[1];
  assert.ok(lastSessionToken);

  const meResponse = await worker.fetch(new Request("https://hackthevalley.org/api/me", {
    headers: { Cookie: `htv_session=${lastSessionToken}` }
  }), { HTV_DB: fakeDb }, {});
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json();
  assert.equal(me.user.email, "maya@example.com");
});

test("worker magic login endpoint sets a session cookie and redirects to a safe next path", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM auth_login_codes alc/.test(sql)) {
            return {
              id: "alc_magic",
              user_id: "usr_maya",
              email: "maya@example.com",
              expires_at: "2999-01-01T00:00:00.000Z",
              user_email: "maya@example.com",
              user_name: "Maya R."
            };
          }
          if (/FROM users WHERE id/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          return null;
        },
        async all() { return { results: [] }; }
      };
    }
  };

  const response = await worker.fetch(new Request("https://hackthevalley.org/api/auth/magic-login?token=htvl_test_magic_token_123456789&next=%2Fprojects%2F"), { HTV_DB: fakeDb }, {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://hackthevalley.org/projects/");
  assert.match(response.headers.get("set-cookie") || "", /htv_session=/);
});

test("/api/me returns participant community state for the signed-in user", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM user_sessions us/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R.", session_id: "ses_1", session_expires_at: "2999-01-01T00:00:00.000Z" };
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          return null;
        },
        async all() {
          if (/FROM roles/.test(sql)) return { results: [] };
          if (/FROM event_participant_events/.test(sql)) return { results: [{ event_slug: "hack-hours", event_instance_id: "inst_1", event_type: "checked_in", occurred_at: "2026-06-20T15:05:00.000Z" }] };
          if (/FROM user_badges/.test(sql)) return { results: [{ slug: "first-attendance", name: "First Attendance", badge_type: "attendance", awarded_at: "2026-06-20T15:05:00.000Z" }] };
          if (/event_project_awards/.test(sql)) return { results: [] };
          if (/FROM project_members/.test(sql)) return { results: [{ project_id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Valley SAT Prep", submission_id: "sub_1", event_slug: "hack-the-valley-2026", status: "accepted" }] };
          return { results: [] };
        }
      };
    }
  };

  const response = await worker.fetch(new Request("https://hackthevalley.org/api/me", {
    headers: { Cookie: "htv_session=test-session-token" }
  }), { HTV_DB: fakeDb }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.email, "maya@example.com");
  assert.deepEqual(body.attendance.map((event) => event.event_slug), ["hack-hours"]);
  assert.deepEqual(body.badges.map((badge) => badge.slug), ["first-attendance", "attended-hack-hours", "submitted-project"]);
  assert.equal(body.badges[0].icon_url, "/images/badges/first-attendance.svg");
  assert.deepEqual(body.projects.map((project) => project.title), ["Valley SAT Prep"]);
});

test("community state derives requested profile badges from attendance, projects, and awards", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM users/.test(sql)) return { id: "usr_aiden", email: "aiden@example.com", name: "Aiden" };
          return null;
        },
        async all() {
          if (/FROM roles/.test(sql)) return { results: [] };
          if (/FROM event_participant_events/.test(sql)) return { results: [
            { event_slug: "hack-the-valley-2026", event_instance_id: "inst_htv_2026", event_type: "checked_in", occurred_at: "2026-05-30T16:00:00.000Z" },
            { event_slug: "hack-hours", event_instance_id: "inst_hh_1", event_type: "checked_in", occurred_at: "2026-06-20T15:05:00.000Z" }
          ] };
          if (/FROM user_badges/.test(sql)) return { results: [] };
          if (/event_project_awards/.test(sql)) return { results: [
            { event_slug: "hack-the-valley-2026", project_id: "prj_decode_it", award_slug: "overall", award_title: "Overall Winner", awarded_at: "2026-05-31T00:00:00.000Z" }
          ] };
          if (/FROM project_members/.test(sql)) return { results: [{ project_id: "prj_decode_it", slug: "decode-it", title: "decode it", event_slug: "hack-the-valley-2026", status: "winner" }] };
          return { results: [] };
        }
      };
    }
  };
  const state = await getUserCommunityState(fakeDb, "usr_aiden");
  assert.deepEqual(state.badges.map((badge) => badge.slug), [
    "attended-htv-2026",
    "attended-hack-hours",
    "submitted-project",
    "won-prize-htv-2026",
    "won-overall-htv-2026"
  ]);
  assert.ok(state.badges.every((badge) => /\/images\/badges\/.+\.svg$/.test(badge.icon_url)));
});

test("schema and migrations add project submission links and badge awards", () => {
  const schema = read("schema.sql");
  const migration = read("migrations/0009_projects_and_badges.sql");
  for (const text of [schema, migration]) {
    assert.match(text, /CREATE TABLE IF NOT EXISTS projects/);
    assert.match(text, /canonical_submission_id TEXT REFERENCES submissions\(id\)/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS project_members/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS event_project_submissions/);
    assert.match(text, /event_instance_id TEXT REFERENCES event_instances\(id\)/);
    assert.match(text, /submission_id TEXT REFERENCES submissions\(id\)/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS badges/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS user_badges/);
    assert.match(text, /UNIQUE\(user_id, badge_id, event_instance_id\)/);
  }
  const badgeCatalog = read("migrations/0015_community_badge_catalog.sql");
  for (const slug of ["attended-htv-2026", "won-prize-htv-2026", "won-overall-htv-2026", "submitted-project", "attended-hack-hours"]) {
    assert.match(schema, new RegExp(slug));
    assert.match(badgeCatalog, new RegExp(slug));
  }
});

test("badge logo assets exist for the requested profile badges", () => {
  for (const slug of ["attended-htv-2026", "won-prize-htv-2026", "won-overall-htv-2026", "submitted-project", "attended-hack-hours"]) {
    const svg = read(`public/images/badges/${slug}.svg`);
    assert.match(svg, /<svg/);
    assert.match(svg, /viewBox="0 0 128 128"/);
    assert.match(svg, /<title id="title">/);
  }
});

test("project helpers create a durable project and link it as an event submission", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM submissions/.test(sql)) return {
            id: "sub_1",
            project_title: "Valley SAT Prep",
            team_name: "Sequoia Sasquatches",
            track: "Education | AI",
            payload_json: JSON.stringify({ description: "SAT prep insight tool", repoLink: "https://github.com/example/sat", demoLink: "https://sat.example.com" })
          };
          if (/FROM projects/.test(sql)) return { id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Valley SAT Prep" };
          return null;
        },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };

  const normalized = normalizeProjectInput({ title: "Valley SAT Prep", team_name: "Sequoia Sasquatches" });
  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.project.slug, "valley-sat-prep");

  const project = await upsertProjectFromSubmission(db, "sub_1", { eventSlug: "hack-the-valley-2026", eventInstanceId: "inst_htv_2026" });
  assert.equal(project.id, "prj_valley_sat_prep");
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO projects/);
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO event_project_submissions/);

  await linkProjectSubmission(db, {
    eventSlug: "hack-the-valley-2026",
    eventInstanceId: "inst_htv_2026",
    projectId: "prj_valley_sat_prep",
    submissionId: "sub_1",
    status: "accepted"
  });
  const link = statements.find((s) => /INSERT INTO event_project_submissions/.test(s.sql) && s.args.includes("accepted"));
  assert.ok(link);
});

test("badge helpers award badges idempotently with event provenance", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM badges/.test(sql)) return { id: "bdg_first_attendance", slug: "first-attendance", name: "First Attendance", badge_type: "attendance" };
          if (/FROM user_badges/.test(sql)) return { id: "ubg_usr_maya_bdg_first_attendance_inst_1", user_id: "usr_maya", badge_id: "bdg_first_attendance", event_instance_id: "inst_1" };
          return null;
        },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };

  const award = await awardBadge(db, {
    userId: "usr_maya",
    badgeSlug: "first-attendance",
    eventInstanceId: "inst_1",
    source: "admin",
    awardedBy: "organizer@example.com"
  });
  assert.equal(award.badge.slug, "first-attendance");
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO badges/);
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT OR IGNORE INTO user_badges/);
  assert.ok(statements.some((s) => s.args.includes("usr_maya") && s.args.includes("inst_1")));
});

test("user community state includes roles, attendance, badges, and submitted projects", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async first() {
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          return null;
        },
        async all() {
          if (/FROM roles/.test(sql)) return { results: [{ role: "organizer", scope_type: "event", scope_id: "hack-hours" }] };
          if (/FROM event_participant_events/.test(sql)) return { results: [{ event_slug: "hack-hours", event_instance_id: "inst_1", event_type: "checked_in", occurred_at: "2026-06-20T15:05:00.000Z" }] };
          if (/FROM user_badges/.test(sql)) return { results: [{ slug: "first-attendance", name: "First Attendance", event_instance_id: "inst_1" }] };
          if (/event_project_awards/.test(sql)) return { results: [] };
          if (/FROM project_members/.test(sql)) return { results: [{ project_id: "prj_valley_sat_prep", title: "Valley SAT Prep", submission_id: "sub_1", event_slug: "hack-the-valley-2026" }] };
          return { results: [] };
        }
      };
    }
  };

  const state = await getUserCommunityState(db, "usr_maya");
  assert.equal(state.user.email, "maya@example.com");
  assert.deepEqual(state.roles.map((role) => role.role), ["organizer"]);
  assert.deepEqual(state.badges.map((badge) => badge.slug), ["first-attendance", "attended-hack-hours", "submitted-project"]);
  assert.deepEqual(state.projects.map((project) => project.title), ["Valley SAT Prep"]);
  assert.match(statements.map((s) => s.sql).join("\n"), /lower\(pm\.email\) = lower\(\?\)/);
  assert.ok(statements.some((s) => s.args.includes("maya@example.com")));
  assert.equal(state.attendance.length, 1);
});

test("listEventProjectSubmissions returns event-linked projects without private contact fields", async () => {
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          return { results: [{
            event_slug: "hack-the-valley-2026",
            event_instance_id: "inst_htv_2026",
            project_id: "prj_calcguide",
            submission_id: "sub_calcguide",
            title: "CalcGuide",
            team_name: "NewtonsNewts",
            status: "accepted",
            contact_email: "private@example.com"
          }] };
        }
      };
    }
  };

  const projects = await listEventProjectSubmissions(db, "hack-the-valley-2026", "inst_htv_2026");
  assert.equal(projects[0].title, "CalcGuide");
  assert.equal(projects[0].submission_id, "sub_calcguide");
  assert.equal(Object.hasOwn(projects[0], "contact_email"), false);
});

test("schema and migration add Hack Hours cockpit tables without scope creep", () => {
  const schema = read("schema.sql");
  const migration = read("migrations/0008_hack_hours_event_cockpit_v0.sql");
  for (const text of [schema, migration]) {
    assert.match(text, /CREATE TABLE IF NOT EXISTS emergency_contacts/);
    assert.match(text, /event_instance_id TEXT NOT NULL REFERENCES event_instances\(id\)/);
    assert.match(text, /UNIQUE\(event_instance_id, user_id\)/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS event_photos/);
    assert.match(text, /kind TEXT NOT NULL CHECK \(kind IN \('photo', 'video'\)\)/);
    assert.match(text, /storage_key TEXT NOT NULL UNIQUE/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS roles/);
    assert.match(text, /scope_id TEXT NOT NULL DEFAULT '\*'/);
    assert.match(text, /WHERE revoked_at IS NULL/);
    const eventPhotosTable = text.match(/CREATE TABLE IF NOT EXISTS event_photos \([\s\S]*?\n\);/)?.[0] || "";
    assert.doesNotMatch(eventPhotosTable, /project_id/);
    assert.doesNotMatch(eventPhotosTable, /submission_id/);
    assert.doesNotMatch(eventPhotosTable, /participant_user_id/);
  }
});

test("package check script covers all event cockpit route modules", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.check, /functions\/api\/auth\/request-code\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/auth\/verify-code\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/me\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/me\/projects\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/events\/\[slug\]\/checkins\/index\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/events\/\[slug\]\/instances\/\[instanceId\]\/cockpit\/index\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/events\/\[slug\]\/instances\/\[instanceId\]\/followup\/index\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/events\/\[slug\]\/instances\/\[instanceId\]\/projects\/index\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/events\/\[slug\]\/instances\/\[instanceId\]\/photos\/index\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/projects\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/projects\/media\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/users\/\[id\]\/state\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/users\/\[id\]\/badges\.js/);
});

test("emergency contact input is required for public signups and ignores school/org", () => {
  const missing = normalizeSignupInput({ name: "Maya R.", email: "maya@example.com" }, "hack-hours");
  assert.match(missing.errors.join("; "), /emergency contact name is required/);
  assert.match(missing.errors.join("; "), /emergency contact phone is required/);

  const { signup, errors } = normalizeSignupInput({
    name: "Maya R.",
    email: "maya@example.com",
    school: "Should not be required",
    emergency_contact_name: "Sam R.",
    emergency_contact_phone: "661-555-0100"
  }, "hack-hours");
  assert.deepEqual(errors, []);
  assert.equal(signup.school, "Should not be required");
  assert.deepEqual(signup.emergency_contact, { name: "Sam R.", phone: "661-555-0100", relationship: null });
});

test("upsertSignup stores emergency contact after resolving user/signup/instance", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/SELECT \* FROM users WHERE email/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM signups s\s+JOIN users/.test(sql)) return { id: "sgn_maya", event_slug: "hack-hours", event_instance_id: "inst_hack_hours_20260620", user_id: "usr_maya", name: "Maya R.", email: "maya@example.com" };
          return { id: "inst_hack_hours_20260620", event_slug: "hack-hours", status: "open" };
        }
      };
      return statement;
    }
  };

  const saved = await upsertSignup(db, "hack-hours", {
    name: "Maya R.",
    email: "maya@example.com",
    emergency_contact_name: "Sam R.",
    emergency_contact_phone: "661-555-0100"
  }, { status: "skipped_opt_out", detail: "test" }, { id: "inst_hack_hours_20260620", event_slug: "hack-hours", status: "open" });

  assert.equal(saved.user_id, "usr_maya");
  const combinedSql = statements.map((statement) => statement.sql).join("\n");
  assert.match(combinedSql, /INSERT INTO emergency_contacts/);
  const contactStatement = statements.find((statement) => /INSERT INTO emergency_contacts/.test(statement.sql));
  assert.ok(contactStatement.args.includes("inst_hack_hours_20260620"));
  assert.ok(contactStatement.args.includes("usr_maya"));
  assert.ok(contactStatement.args.includes("sgn_maya"));
});

test("rendered public RSVP collects emergency contact and excludes school notes and waiver copy", () => {
  const html = renderEventPageHtml({ slug: "hack-hours", title: "Hack Hours", status: "open", description: "Build with neighbors." });
  assert.match(html, /name="emergency_contact_name"/);
  assert.match(html, /name="emergency_contact_phone"/);
  assert.match(html, /Save my spot/);
  assert.match(html, /Emergency contact saved/);
  assert.doesNotMatch(html, /name="school"/);
  assert.doesNotMatch(html, /School \/ org/i);
  assert.doesNotMatch(html, /name="notes"/);
  assert.doesNotMatch(html, /waiver/i);
});

test("organizer access helpers require session roles and separate super admin", async () => {
  const baseDb = { prepare() { throw new Error("base DB should not be queried by auth helper test"); } };
  const request = new Request("https://hackthevalley.org/admin", { headers: adminHeaders() });
  const organizer = await requireOrganizerAccess(request, { HTV_DB: withAdminRoleDb(baseDb, { role: "admin" }) });
  assert.equal(organizer.role.role, "admin");
  const superAdmin = await requireSuperAdminAccess(request, { HTV_DB: withAdminRoleDb(baseDb, { role: "super_admin" }) });
  assert.equal(superAdmin.role.role, "super_admin");
  await assert.rejects(
    () => requireOrganizerAccess(new Request("https://hackthevalley.org/admin"), { HTV_DB: withAdminRoleDb(baseDb, { role: "admin" }) }),
    /Unauthorized/
  );
});

test("cockpit helper returns summary, roster, emergency state, progression labels, and photo count", async () => {
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/COUNT\(\*\) AS count/.test(sql)) return { count: 9 };
          if (/FROM event_instances/.test(sql)) return { id: "inst_hack_hours_20260620", event_slug: "hack-hours", instance_key: "2026-06-20", starts_at: "2026-06-20T17:00:00.000Z" };
          if (/FROM events/.test(sql)) return { slug: "hack-hours", title: "Hack Hours" };
          return null;
        },
        async all() {
          if (/FROM signups s/.test(sql)) return { results: [
            { user_id: "usr_maya", signup_id: "sgn_maya", event_instance_id: "inst_hack_hours_20260620", name: "Maya R.", email: "maya@example.com", signed_up_at: "2026-06-13T10:00:00.000Z", checked_in_at: null, emergency_contact_present: 1, attendance_count: 1, prior_attendance_count: 1 },
            { user_id: "usr_no_contact", signup_id: "sgn_no_contact", event_instance_id: "inst_hack_hours_20260620", name: "No Contact", email: "nocontact@example.com", signed_up_at: "2026-06-13T10:01:00.000Z", checked_in_at: "2026-06-20T17:10:00.000Z", emergency_contact_present: 0, attendance_count: 3, prior_attendance_count: 2 },
            { user_id: "usr_new", signup_id: "sgn_new", event_instance_id: "inst_hack_hours_20260620", name: "New Builder", email: "new@example.com", signed_up_at: "2026-06-13T10:02:00.000Z", checked_in_at: null, emergency_contact_present: 1, attendance_count: 0, prior_attendance_count: 0 }
          ] };
          if (/FROM event_photos/.test(sql)) return { results: [{ id: "pho_1", kind: "photo", storage_key: "event-photos/inst_hack_hours_20260620/pho_1-photo.jpg", created_at: "2026-06-20T18:00:00.000Z" }] };
          return { results: [] };
        }
      };
    }
  };
  const cockpit = await getEventCockpit(db, "hack-hours", "inst_hack_hours_20260620");
  assert.equal(cockpit.summary.signed_up_count, 3);
  assert.equal(cockpit.summary.checked_in_count, 1);
  assert.equal(cockpit.summary.missing_emergency_contact_count, 1);
  assert.equal(cockpit.summary.event_photo_count, 9);
  assert.equal(cockpit.photos.count, 9);
  assert.equal(cockpit.photos.recent.length, 1);
  assert.equal(cockpit.summary.repeat_attendee_count, 2);
  assert.equal(cockpit.roster[0].prior_attendance_count, 1);
  assert.deepEqual(cockpit.roster[0].progression_labels, ["repeat"]);
  assert.deepEqual(cockpit.roster[1].progression_labels, ["repeat", "3x attendee"]);
  assert.deepEqual(cockpit.roster[2].progression_labels, ["first-time"]);
  assert.equal(Object.hasOwn(cockpit.roster[0], "school"), false);
  assert.equal(Object.hasOwn(cockpit.roster[0], "notes"), false);
});

test("follow-up packet builds approval-gated draft and safe segments without emergency contact details", async () => {
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/COUNT\(\*\) AS count/.test(sql)) return { count: 2 };
          if (/FROM event_instances/.test(sql)) return { id: "inst_hack_hours_20260620", event_slug: "hack-hours", instance_key: "2026-06-20", starts_at: "2026-06-20T15:00:00.000Z" };
          if (/FROM events/.test(sql)) return { slug: "hack-hours", title: "Hack Hours" };
          return null;
        },
        async all() {
          if (/FROM signups s/.test(sql)) return { results: [
            { user_id: "usr_attended", signup_id: "sgn_attended", event_instance_id: "inst_hack_hours_20260620", name: "=Ava Attended", email: "ava@example.com", signed_up_at: "2026-06-20T14:00:00.000Z", checked_in_at: "2026-06-20T15:05:00.000Z", emergency_contact_present: 1, attendance_count: 1 },
            { user_id: "usr_repeat", signup_id: "sgn_repeat", event_instance_id: "inst_hack_hours_20260620", name: "Riley Repeat", email: "riley@example.com", signed_up_at: "2026-06-20T14:05:00.000Z", checked_in_at: "2026-06-20T15:08:00.000Z", emergency_contact_present: 1, attendance_count: 3 },
            { user_id: "usr_noshow", signup_id: "sgn_noshow", event_instance_id: "inst_hack_hours_20260620", name: "No Show", email: "noshow@example.com", signed_up_at: "2026-06-20T14:10:00.000Z", checked_in_at: null, emergency_contact_present: 1, attendance_count: 0 }
          ] };
          if (/FROM event_photos/.test(sql)) return { results: [{ id: "pho_1" }, { id: "pho_2" }] };
          return { results: [] };
        }
      };
    }
  };
  const packet = await getEventFollowupPacket(db, "hack-hours", "inst_hack_hours_20260620");
  assert.equal(packet.summary.signed_up_count, 3);
  assert.equal(packet.summary.checked_in_count, 2);
  assert.equal(packet.summary.no_show_count, 1);
  assert.equal(packet.summary.first_time_attendee_count, 1);
  assert.equal(packet.summary.repeat_attendee_count, 1);
  assert.deepEqual(packet.segments.attended.map((row) => row.email), ["ava@example.com", "riley@example.com"]);
  assert.deepEqual(packet.segments.no_show.map((row) => row.email), ["noshow@example.com"]);
  assert.equal(packet.followup_draft.status, "needs_review");
  assert.equal(packet.followup_draft.requires_approval, true);
  assert.match(packet.segment_csv.attended, /email,name,segment,checked_in_at,attendance_count/);
  assert.match(packet.segment_csv.attended, /ava@example\.com,'=Ava Attended,attended/);
  assert.doesNotMatch(packet.segment_csv.attended, /emergency|phone|contact/i);
});

test("worker routes event project submissions API and requires admin", async () => {
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM submissions/.test(sql)) return { id: "sub_1", project_title: "CalcGuide", team_name: "NewtonsNewts", track: "Education", payload_json: JSON.stringify({ description: "Calculus tutor" }) };
          if (/FROM projects/.test(sql)) return { id: "prj_calcguide", slug: "calcguide", title: "CalcGuide" };
          return null;
        },
        async all() {
          return { results: [{ event_slug: "hack-the-valley-2026", event_instance_id: "inst_2026", project_id: "prj_calcguide", submission_id: "sub_1", title: "CalcGuide", team_name: "NewtonsNewts", status: "accepted", contact_email: "private@example.com" }] };
        }
      };
    }
  };
  const url = "https://hackthevalley.org/api/events/hack-the-valley-2026/instances/inst_2026/projects";
  const unauthorized = await worker.fetch(new Request(url), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(unauthorized.status, 401);
  const create = await worker.fetch(new Request(url, {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ submission_id: "sub_1", status: "accepted", source: "request-body-should-not-win" })
  }), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(create.status, 200);
  const created = await create.json();
  assert.equal(created.project.title, "CalcGuide");
  const eventLinkInsert = statements.find((statement) => /INSERT INTO event_project_submissions/.test(statement.sql));
  assert.equal(eventLinkInsert.args[6], "organizer:usr_admin");
  assert.notEqual(eventLinkInsert.args[6], "request-body-should-not-win");
  const list = await worker.fetch(new Request(url, { headers: adminHeaders() }), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.projects[0].title, "CalcGuide");
  assert.equal(Object.hasOwn(listed.projects[0], "contact_email"), false);
});

test("worker routes admin soft-cleanup for event-linked projects", async () => {
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM event_project_submissions eps/.test(sql)) return { event_slug: "hack-the-valley-2026", project_id: "prj_smoke", status: "submitted", title: "Smoke" };
          return null;
        },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };
  const url = "https://hackthevalley.org/api/events/hack-the-valley-2026/projects/prj_smoke";
  const options = await worker.fetch(new Request(url, { method: "OPTIONS" }), { HTV_DB: fakeDb, SUBMISSIONS_ADMIN_TOKEN: "secret" }, {});
  assert.equal(options.status, 204);
  assert.match(options.headers.get("access-control-allow-methods") || "", /PATCH/);
  const unauthorized = await worker.fetch(new Request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "hidden" }) }), { HTV_DB: fakeDb, SUBMISSIONS_ADMIN_TOKEN: "secret" }, {});
  assert.equal(unauthorized.status, 401);
  const hidden = await worker.fetch(new Request(url, { method: "PATCH", headers: { "x-admin-token": "secret", "Content-Type": "application/json" }, body: JSON.stringify({ status: "hidden" }) }), { HTV_DB: fakeDb, SUBMISSIONS_ADMIN_TOKEN: "secret" }, {});
  assert.equal(hidden.status, 200);
  const body = await hidden.json();
  assert.equal(body.project.status, "hidden");
  assert.ok(statements.some((s) => s.args.includes("hidden") && s.args.includes("prj_smoke")));
  const list = await worker.fetch(new Request("https://hackthevalley.org/api/events/hack-the-valley-2026/projects", { headers: { "x-admin-token": "secret" } }), { HTV_DB: fakeDb, SUBMISSIONS_ADMIN_TOKEN: "secret" }, {});
  assert.equal(list.status, 200);
  assert.equal((await list.json()).count, 0);
});

test("participant projects workspace lives under /me/projects while /projects is public showcase", () => {
  const publicProjects = read("public/projects/index.html");
  const manageProjects = read("public/me/projects/index.html");
  const homepage = read("public/index.html");
  const recap = read("public/events/hack-the-valley-2026/index.html");

  assert.match(publicProjects, /Student project showcase/);
  assert.match(publicProjects, /\/api\/projects\?event=hack-the-valley-2026/);
  assert.match(publicProjects, /Contact details and private submission metadata stay out of this view/);
  assert.match(publicProjects, /function heroMarkup\(project\)/);
  assert.match(publicProjects, /<img class="h-48 w-full object-cover"/);
  assert.match(publicProjects, /<video class="h-48 w-full object-cover"/);
  assert.doesNotMatch(publicProjects, /id="project-create-form"/);
  assert.match(manageProjects, /id="project-create-form"/);
  assert.match(homepage, /\/login\/\?next=\/me\/projects\//);
  assert.match(recap, /\/me\/projects\/\?event=hack-the-valley-2026/);
});

test("public project listing returns safe public fields and awards", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      statements.push(sql);
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          return { results: [{
            event_slug: "hack-the-valley-2026",
            status: "showcased",
            updated_at: "2026-06-16T00:00:00.000Z",
            project_id: "prj_techpath_kern",
            slug: "techpath-kern",
            title: "TechPath Kern",
            team_name: "Kern Coders",
            description: "Opportunity navigator for Kern County students.",
            repo_url: "https://github.com/JCVB51/techpath-kern",
            demo_url: null,
            tracks_json: JSON.stringify(["Education", "Social Impact", "AI"]),
            submission_created_at: "2026-05-30T23:44:23.846Z",
            hero_uploads_json: JSON.stringify([{ key: "submissions/kern-coders/screenshot.png", kind: "image", filename: "screenshot.png", contentType: "image/png", size: 1234 }]),
            awards_json: JSON.stringify([{ award_slug: "social-impact", award_title: "Best Social Impact", award_rank: 1, prize_amount_cents: 20000 }]),
            contact_email: "must-not-leak@example.com",
            uploads_json: JSON.stringify([{ key: "private-r2-key" }])
          }] };
        }
      };
    }
  };
  const projects = await listPublicProjects(db, { eventSlug: "hack-the-valley-2026" });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].title, "TechPath Kern");
  assert.deepEqual(projects[0].tracks, ["Education", "Social Impact", "AI"]);
  assert.equal(projects[0].awards[0].title, "Best Social Impact");
  assert.equal(projects[0].awards[0].prize_amount_cents, 20000);
  assert.equal(projects[0].contact_email, undefined);
  assert.equal(projects[0].uploads_json, undefined);
  assert.equal(projects[0].hero_media.url, "/api/projects/media?event=hack-the-valley-2026&project=techpath-kern");
  assert.equal(projects[0].hero_media.kind, "image");
  assert.equal(projects[0].hero_media.key, undefined);
  assert.match(statements.join("\n"), /event_project_awards/);
  assert.match(statements.join("\n"), /MIN\(s\.created_at\) AS submission_created_at/);
  assert.match(statements.join("\n"), /MAX\(eps\.updated_at\) AS updated_at/);
  assert.doesNotMatch(statements.join("\n"), /GROUP BY[\s\S]*s\.created_at/);
  assert.doesNotMatch(statements.join("\n"), /GROUP BY[\s\S]*eps\.updated_at/);
});

test("worker exposes public projects API without admin auth", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          return { results: [{
            event_slug: this.args?.[0] || "hack-the-valley-2026",
            status: "showcased",
            project_id: "prj_decode_it",
            slug: "decode-it",
            title: "decode it",
            team_name: "aiden michael sawyer preston",
            description: "Guided document walkthrough platform.",
            repo_url: "https://github.com/prest2323/decode-this.git",
            demo_url: null,
            tracks_json: JSON.stringify(["Education", "Social Impact", "AI"]),
            awards_json: "[]"
          }] };
        }
      };
    }
  };
  const response = await worker.fetch(new Request("https://hackthevalley.org/api/projects?event=hack-the-valley-2026"), { HTV_DB: fakeDb }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 1);
  assert.equal(body.projects[0].title, "decode it");
});

test("public project media endpoint serves only media attached to a public project", async () => {
  const imageBytes = new Uint8Array([137, 80, 78, 71]);
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          assert.deepEqual(this.args, ["hack-the-valley-2026", "techpath-kern"]);
          assert.match(sql, /eps\.status NOT IN \('hidden', 'rejected'\)/);
          return { results: [{ uploads_json: JSON.stringify([
            { key: "submissions/kern-coders/readme.txt", kind: "file", contentType: "text/plain" },
            { key: "submissions/kern-coders/screenshot.png", kind: "image", filename: "screenshot.png", contentType: "image/png" }
          ]) }] };
        }
      };
    }
  };
  const media = await getPublicProjectHeroMedia(db, { eventSlug: "hack-the-valley-2026", projectSlug: "techpath-kern" });
  assert.equal(media.key, "submissions/kern-coders/screenshot.png");

  const response = await worker.fetch(new Request("https://hackthevalley.org/api/projects/media?event=hack-the-valley-2026&project=techpath-kern"), {
    HTV_DB: db,
    SUBMISSIONS_MEDIA: {
      async get(key) {
        assert.equal(key, "submissions/kern-coders/screenshot.png");
        return {
          body: imageBytes,
          httpEtag: '"abc"',
          customMetadata: { originalFilename: "screenshot.png" },
          writeHttpMetadata(headers) { headers.set("content-type", "image/png"); }
        };
      }
    }
  }, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("cache-control") || "", /public/);
  assert.equal(await response.arrayBuffer().then((buffer) => new Uint8Array(buffer)[1]), 80);
});

test("schema and migrations add public project awards table", () => {
  const schema = read("schema.sql");
  const migration = read("migrations/0013_event_project_awards.sql");
  for (const text of [schema, migration]) {
    assert.match(text, /CREATE TABLE IF NOT EXISTS event_project_awards/);
    assert.match(text, /UNIQUE\(event_slug, project_id, award_slug\)/);
    assert.match(text, /idx_event_project_awards_event/);
  }
});

test("worker routes user state and badge award APIs behind admin auth", async () => {
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { statements.push({ sql, args }); this.args = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM badges/.test(sql)) return { id: "bdg_shared_demo", slug: "shared-demo", name: "Shared a Demo", badge_type: "demo" };
          if (/FROM user_badges/.test(sql)) return { id: "ubg_1", user_id: "usr_maya", badge_id: "bdg_shared_demo", event_instance_id: "inst_1" };
          return null;
        },
        async all() {
          if (/FROM user_badges/.test(sql)) return { results: [{ slug: "shared-demo", name: "Shared a Demo", event_instance_id: "inst_1" }] };
          return { results: [] };
        }
      };
    }
  };
  const stateUrl = "https://hackthevalley.org/api/users/usr_maya/state";
  assert.equal((await worker.fetch(new Request(stateUrl), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {})).status, 401);
  const stateResponse = await worker.fetch(new Request(stateUrl, { headers: adminHeaders() }), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.user.email, "maya@example.com");

  const badgeUrl = "https://hackthevalley.org/api/users/usr_maya/badges";
  const badgeResponse = await worker.fetch(new Request(badgeUrl, {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ badge_slug: "shared-demo", event_instance_id: "inst_1", source: "derived", awarded_by: "usr_forged" })
  }), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(badgeResponse.status, 200);
  const awarded = await badgeResponse.json();
  assert.equal(awarded.badge.slug, "shared-demo");
  const badgeInsert = statements.find((statement) => /INSERT OR IGNORE INTO user_badges/.test(statement.sql));
  assert.ok(badgeInsert);
  assert.equal(badgeInsert.args[5], "admin");
  assert.equal(badgeInsert.args[6], "usr_admin");
});

test("worker routes follow-up packet API and requires admin", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/COUNT\(\*\) AS count/.test(sql)) return { count: 0 };
          if (/FROM event_instances/.test(sql)) return { id: "inst_123", event_slug: "hack-hours", instance_key: "2026-06-20" };
          if (/FROM events/.test(sql)) return { slug: "hack-hours", title: "Hack Hours" };
          return null;
        },
        async all() { return { results: [] }; }
      };
    }
  };
  const url = "https://hackthevalley.org/api/events/hack-hours/instances/inst_123/followup";
  const unauthorized = await worker.fetch(new Request(url), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(unauthorized.status, 401);
  const response = await worker.fetch(new Request(url, { headers: adminHeaders() }), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.followup_draft.status, "needs_review");
  assert.equal(body.followup_draft.requires_approval, true);
});

test("worker routes cockpit API and requires admin", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM event_instances/.test(sql)) return { id: "inst_123", event_slug: "hack-hours", instance_key: "2026-06-20" };
          if (/FROM events/.test(sql)) return { slug: "hack-hours", title: "Hack Hours" };
          return null;
        },
        async all() { return { results: [] }; }
      };
    }
  };
  const url = "https://hackthevalley.org/api/events/hack-hours/instances/inst_123/cockpit";
  const unauthorized = await worker.fetch(new Request(url), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(unauthorized.status, 401);
  const response = await worker.fetch(new Request(url, { headers: adminHeaders() }), { HTV_DB: withAdminRoleDb(fakeDb), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.instance.id, "inst_123");
});

test("check-in allows existing users without emergency contact and keeps manual walk-up contact gate", async () => {
  const sqls = [];
  const db = {
    prepare(sql) {
      sqls.push(sql);
      return {
        bind(...args) { this.args = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (/SELECT \* FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM signups s/.test(sql)) return { id: "sgn_maya", event_slug: "hack-hours", event_instance_id: "inst_hack_hours_20260620", user_id: "usr_maya", name: "Maya R.", email: "maya@example.com", checked_in_at: null };
          if (/FROM emergency_contacts/.test(sql)) return null;
          return null;
        }
      };
    }
  };

  const result = await checkInAttendee(
    db,
    { slug: "hack-hours", title: "Hack Hours" },
    { user_id: "usr_maya" },
    { eventInstance: { id: "inst_hack_hours_20260620", event_slug: "hack-hours" } }
  );
  assert.equal(result.signup.user_id, "usr_maya");
  assert.doesNotMatch(sqls.join("\n"), /FROM emergency_contacts/);

  await assert.rejects(
    () => checkInAttendee(db, { slug: "hack-hours", title: "Hack Hours" }, { name: "New Person", email: "new@example.com" }, { eventInstance: { id: "inst_hack_hours_20260620", event_slug: "hack-hours" } }),
    (error) => error.status === 400 && /emergency contact/.test(error.message)
  );
});

test("event photo helpers validate instance scope and write metadata with event-only linkage", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() { return { count: 42 }; },
        async all() { return { results: [{ id: "pho_1", event_instance_id: "inst_1", storage_key: "event-photos/inst_1/pho_1-photo.jpg" }] }; }
      };
    }
  };
  await createEventPhotoRecord(db, { id: "pho_1", eventSlug: "hack-hours", eventInstanceId: "inst_1", kind: "photo", storageKey: "event-photos/inst_1/pho_1-photo.jpg", originalFilename: "photo.jpg", contentType: "image/jpeg", bytes: 12 });
  const photos = await listEventPhotos(db, "hack-hours", "inst_1");
  const photoCount = await countEventPhotos(db, "hack-hours", "inst_1");
  assert.equal(photos[0].storage_key, "event-photos/inst_1/pho_1-photo.jpg");
  assert.equal(photoCount, 42);
  const insert = statements.find((statement) => /INSERT INTO event_photos/.test(statement.sql));
  assert.match(insert.sql, /event_instance_id/);
  assert.doesNotMatch(insert.sql, /project_id/);
  assert.doesNotMatch(insert.sql, /submission_id/);
});

test("event photo route validates auth, R2, MIME, filename, and event-photo storage prefix", async () => {
  const stored = new Map();
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM event_instances/.test(sql)) return { id: "inst_1", event_slug: "hack-hours" };
          return null;
        },
        async run() { return { success: true }; },
        async all() { return { results: [] }; }
      };
    }
  };
  const url = "https://hackthevalley.org/api/events/hack-hours/instances/inst_1/photos?filename=../photo.jpg&kind=photo";
  const noStorage = await worker.fetch(new Request(url, { method: "POST", headers: adminHeaders({ "Content-Type": "image/jpeg", "Content-Length": "12" }), body: "fake" }), { HTV_DB: withAdminRoleDb(db), HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(noStorage.status, 503);
  const badType = await worker.fetch(new Request(url, { method: "POST", headers: adminHeaders({ "Content-Type": "text/plain", "Content-Length": "12" }), body: "fake" }), { HTV_DB: withAdminRoleDb(db), HTV_ADMIN_TOKEN: "secret", SUBMISSIONS_MEDIA: { put: async () => {} } }, {});
  assert.equal(badType.status, 400);
  const oversizeWithoutLength = await worker.fetch(new Request(url, { method: "POST", headers: adminHeaders({ "Content-Type": "image/jpeg" }), body: "fake" }), {
    HTV_DB: withAdminRoleDb(db),
    HTV_ADMIN_TOKEN: "secret",
    MAX_UPLOAD_BYTES: "1",
    SUBMISSIONS_MEDIA: { async put() { throw new Error("oversize upload should not be stored"); } }
  }, {});
  assert.equal(oversizeWithoutLength.status, 400);
  const response = await worker.fetch(new Request(url, { method: "POST", headers: adminHeaders({ "Content-Type": "image/jpeg", "Content-Length": "12" }), body: "fake" }), {
    HTV_DB: withAdminRoleDb(db),
    HTV_ADMIN_TOKEN: "secret",
    SUBMISSIONS_MEDIA: { async put(key, body, options) { stored.set(key, { body: await new Response(body).text(), options }); } }
  }, {});
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.photo.storage_key, /^event-photos\/inst_1\/pho_/);
  assert.doesNotMatch(body.photo.storage_key, /\.\./);
  assert.equal(stored.size, 1);
});

test("admin page defaults to Hack Hours cockpit with roster, participant state, badges, projects, contact resolution, event photo upload, and follow-up packet", () => {
  const html = read("public/admin.html");
  assert.match(html, /id="event-cockpit"/);
  assert.match(html, /id="cockpit-roster"/);
  assert.match(html, /id="cockpit-summary"/);
  assert.match(html, /id="event-photo-upload"/);
  assert.match(html, /id="followup-packet"/);
  assert.match(html, /id="load-followup-packet"/);
  assert.match(html, /id="followup-packet-output"/);
  assert.match(html, /function loadEventCockpit/);
  assert.match(html, /function loadFollowupPacket/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/instances\/\$\{encodeURIComponent\(instanceId\)\}\/cockpit/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/instances\/\$\{encodeURIComponent\(instanceId\)\}\/followup/);
  assert.match(html, /name="emergency_contact_name"/);
  assert.match(html, /name="emergency_contact_phone"/);
  assert.match(html, /Add emergency contact|Update emergency contact/);
  assert.match(html, /Event photos/);
  assert.match(html, /id="participant-state"/);
  assert.match(html, /id="participant-state-output"/);
  assert.match(html, /data-view-state/);
  assert.match(html, /data-award-badge/);
  assert.match(html, /function loadParticipantState/);
  assert.match(html, /function awardParticipantBadge/);
  assert.match(html, /\/api\/users\/\$\{encodeURIComponent\(userId\)\}\/state/);
  assert.match(html, /\/api\/users\/\$\{encodeURIComponent\(userId\)\}\/badges/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/instances\/\$\{encodeURIComponent\(instanceId\)\}\/projects/);
  assert.match(html, /Project submissions/);
  assert.match(html, /Award demo badge/);
  assert.ok(html.indexOf("id=\"event-cockpit\"") < html.indexOf("id=\"event-form\""));
  const cockpit = html.slice(html.indexOf("id=\"event-cockpit\""), html.indexOf("id=\"events-admin\""));
  assert.doesNotMatch(cockpit, /School/);
  assert.doesNotMatch(cockpit, /Notes/);
  assert.doesNotMatch(cockpit, /Waiver/);
  assert.doesNotMatch(cockpit, /participant upload/i);
});
