import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  awardBadge,
  checkInAttendee,
  claimProjectForUser,
  submitOwnedProjectToEvent,
  updateOwnedProjectForUser,
  countEventPhotos,
  createEventPhotoRecord,
  getEventCockpit,
  getCurrentUserFromSession,
  getEventFollowupPacket,
  getUserCommunityState,
  linkProjectSubmission,
  listEventPhotos,
  listEventProjectSubmissions,
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
  verifyLoginCode
} from "../functions/_lib/event-platform.js";
import worker from "../worker.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("participant login page requests a code, verifies it, and reads /api/me", () => {
  const html = read("public/login/index.html");
  assert.match(html, /id="login-request-form"/);
  assert.match(html, /id="login-verify-form"/);
  assert.match(html, /\/api\/auth\/request-code/);
  assert.match(html, /\/api\/auth\/verify-code/);
  assert.match(html, /\/api\/me/);
  assert.match(html, /Check your email/);
  assert.doesNotMatch(html, /admin password|HTV_ADMIN_TOKEN/i);
});

test("participant profile shows editable profile info, badges, and project summary from /api/me", () => {
  const html = read("public/me/index.html");
  assert.match(html, /id="participant-profile"/);
  assert.match(html, /id="profile-card"/);
  assert.match(html, /id="profile-edit-form"/);
  assert.match(html, /\/api\/me/);
  assert.match(html, /fetch\("\/api\/me"/);
  assert.doesNotMatch(html, /API_ORIGIN\s*=\s*'https:\/\/hack-the-valley\.pages\.dev'/);
  assert.match(html, /method: "PATCH"/);
  assert.match(html, /id="attendance-list"/);
  assert.match(html, /id="project-summary-list"/);
  assert.match(html, /id="badge-list"/);
  assert.match(html, /\/projects\//);
  assert.match(html, /\/login\//);
  assert.match(html, /Open project workspace/);
  assert.match(html, /Badges/);
  assert.doesNotMatch(html, /id="project-create-form"/);
  assert.doesNotMatch(html, /Showcase event slug|name="event_slug"/);
  assert.doesNotMatch(html, /HTV_ADMIN_TOKEN|data-award-badge/i);
});

test("participant projects workspace lets signed-in users create, edit, upload, and submit projects", () => {
  const html = read("public/projects/index.html");
  assert.match(html, /id="participant-projects"/);
  assert.match(html, /id="project-create-form"/);
  assert.match(html, /name="title"/);
  assert.match(html, /name="repo_url"/);
  assert.match(html, /name="demo_url"/);
  assert.match(html, /\/api\/me\/projects/);
  assert.match(html, /\/api\/upload/);
  assert.match(html, /fetch\("\/api\/me"/);
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

test("legacy submit paths redirect to the project workspace", async () => {
  for (const path of ["/submit", "/submit/"]) {
    const response = await worker.fetch(new Request(`https://hackthevalley.org${path}`), {}, {});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://hackthevalley.org/projects/");
  }
});

test("claimProjectForUser creates a project and records owner membership", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; statements.push(this); return this; },
        async run() { return { success: true }; },
        async first() {
          if (/FROM projects/.test(sql)) return { id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Valley SAT Prep" };
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

test("owned project helpers reject edits when the user is not a project member", async () => {
  const db = { prepare(sql) { return { bind() { return this; }, async first() { return /FROM users/.test(sql) ? { id: "usr_intruder", email: "intruder@example.com" } : null; }, async run() { return {}; } }; } };
  await assert.rejects(
    () => updateOwnedProjectForUser(db, "usr_intruder", "prj_1", { title: "Nope" }),
    /Project not found/
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

test("/api/me/projects lets the signed-in user create a project and returns refreshed state", async () => {
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
          if (/FROM users/.test(sql)) return { id: "usr_maya", email: "maya@example.com", name: "Maya R." };
          if (/FROM projects/.test(sql)) return { id: "prj_valley_sat_prep", slug: "valley-sat-prep", title: "Valley SAT Prep" };
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
    body: JSON.stringify({ title: "Valley SAT Prep", team_name: "Sequoia Sasquatches" })
  }), { HTV_DB: fakeDb }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.project.title, "Valley SAT Prep");
  assert.equal(body.state.user.email, "maya@example.com");
  assert.match(statements.map((s) => s.sql).join("\n"), /INSERT INTO project_members/);
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
    HTV_LOGIN_FROM_EMAIL: "Hack the Valley <updates@hackthevalley.org>"
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
  assert.match(calls[0].body.text, /123456/);
  assert.match(calls[0].body.html, /123456/);
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
  assert.deepEqual(body.badges.map((badge) => badge.slug), ["first-attendance"]);
  assert.deepEqual(body.projects.map((project) => project.title), ["Valley SAT Prep"]);
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
          if (/FROM project_members/.test(sql)) return { results: [{ project_id: "prj_valley_sat_prep", title: "Valley SAT Prep", submission_id: "sub_1", event_slug: "hack-the-valley-2026" }] };
          return { results: [] };
        }
      };
    }
  };

  const state = await getUserCommunityState(db, "usr_maya");
  assert.equal(state.user.email, "maya@example.com");
  assert.deepEqual(state.roles.map((role) => role.role), ["organizer"]);
  assert.deepEqual(state.badges.map((badge) => badge.slug), ["first-attendance"]);
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

test("organizer access helpers exist and delegate to the current admin token gate", () => {
  const request = new Request("https://hackthevalley.org/admin", { headers: { Authorization: "Bearer secret" } });
  assert.equal(requireOrganizerAccess(request, { HTV_ADMIN_TOKEN: "secret" }), undefined);
  assert.equal(requireSuperAdminAccess(request, { HTV_ADMIN_TOKEN: "secret" }), undefined);
  assert.throws(() => requireOrganizerAccess(new Request("https://hackthevalley.org/admin"), { HTV_ADMIN_TOKEN: "secret" }), /Unauthorized/);
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
            { user_id: "usr_maya", signup_id: "sgn_maya", event_instance_id: "inst_hack_hours_20260620", name: "Maya R.", email: "maya@example.com", signed_up_at: "2026-06-13T10:00:00.000Z", checked_in_at: null, emergency_contact_present: 1, attendance_count: 1 },
            { user_id: "usr_no_contact", signup_id: "sgn_no_contact", event_instance_id: "inst_hack_hours_20260620", name: "No Contact", email: "nocontact@example.com", signed_up_at: "2026-06-13T10:01:00.000Z", checked_in_at: "2026-06-20T17:10:00.000Z", emergency_contact_present: 0, attendance_count: 3 }
          ] };
          if (/FROM event_photos/.test(sql)) return { results: [{ id: "pho_1", kind: "photo", storage_key: "event-photos/inst_hack_hours_20260620/pho_1-photo.jpg", created_at: "2026-06-20T18:00:00.000Z" }] };
          return { results: [] };
        }
      };
    }
  };
  const cockpit = await getEventCockpit(db, "hack-hours", "inst_hack_hours_20260620");
  assert.equal(cockpit.summary.signed_up_count, 2);
  assert.equal(cockpit.summary.checked_in_count, 1);
  assert.equal(cockpit.summary.missing_emergency_contact_count, 1);
  assert.equal(cockpit.summary.event_photo_count, 9);
  assert.equal(cockpit.photos.count, 9);
  assert.equal(cockpit.photos.recent.length, 1);
  assert.equal(cockpit.summary.repeat_attendee_count, 1);
  assert.deepEqual(cockpit.roster[0].progression_labels, ["first-time"]);
  assert.deepEqual(cockpit.roster[1].progression_labels, ["repeat", "3x attendee"]);
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
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
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
  const unauthorized = await worker.fetch(new Request(url), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(unauthorized.status, 401);
  const create = await worker.fetch(new Request(url, {
    method: "POST",
    headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    body: JSON.stringify({ submission_id: "sub_1", status: "accepted" })
  }), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(create.status, 200);
  const created = await create.json();
  assert.equal(created.project.title, "CalcGuide");
  const list = await worker.fetch(new Request(url, { headers: { Authorization: "Bearer secret" } }), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.projects[0].title, "CalcGuide");
  assert.equal(Object.hasOwn(listed.projects[0], "contact_email"), false);
});

test("worker routes user state and badge award APIs behind admin auth", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
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
  assert.equal((await worker.fetch(new Request(stateUrl), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {})).status, 401);
  const stateResponse = await worker.fetch(new Request(stateUrl, { headers: { Authorization: "Bearer secret" } }), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.user.email, "maya@example.com");

  const badgeUrl = "https://hackthevalley.org/api/users/usr_maya/badges";
  const badgeResponse = await worker.fetch(new Request(badgeUrl, {
    method: "POST",
    headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    body: JSON.stringify({ badge_slug: "shared-demo", event_instance_id: "inst_1", source: "admin" })
  }), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(badgeResponse.status, 200);
  const awarded = await badgeResponse.json();
  assert.equal(awarded.badge.slug, "shared-demo");
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
  const unauthorized = await worker.fetch(new Request(url), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(unauthorized.status, 401);
  const response = await worker.fetch(new Request(url, { headers: { Authorization: "Bearer secret" } }), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {});
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
  const unauthorized = await worker.fetch(new Request(url), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(unauthorized.status, 401);
  const response = await worker.fetch(new Request(url, { headers: { Authorization: "Bearer secret" } }), { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.instance.id, "inst_123");
});

test("check-in blocks missing emergency contact and exposes idempotent already checked-in state", async () => {
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
  await assert.rejects(
    () => checkInAttendee(db, { slug: "hack-hours", title: "Hack Hours" }, { user_id: "usr_maya" }, { eventInstance: { id: "inst_hack_hours_20260620", event_slug: "hack-hours" } }),
    (error) => error.status === 409 && error.code === "missing_emergency_contact"
  );
  assert.match(sqls.join("\n"), /FROM emergency_contacts/);
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
  const noStorage = await worker.fetch(new Request(url, { method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "image/jpeg", "Content-Length": "12" }, body: "fake" }), { HTV_DB: db, HTV_ADMIN_TOKEN: "secret" }, {});
  assert.equal(noStorage.status, 503);
  const badType = await worker.fetch(new Request(url, { method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "text/plain", "Content-Length": "12" }, body: "fake" }), { HTV_DB: db, HTV_ADMIN_TOKEN: "secret", SUBMISSIONS_MEDIA: { put: async () => {} } }, {});
  assert.equal(badType.status, 400);
  const oversizeWithoutLength = await worker.fetch(new Request(url, { method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "image/jpeg" }, body: "fake" }), {
    HTV_DB: db,
    HTV_ADMIN_TOKEN: "secret",
    MAX_UPLOAD_BYTES: "1",
    SUBMISSIONS_MEDIA: { async put() { throw new Error("oversize upload should not be stored"); } }
  }, {});
  assert.equal(oversizeWithoutLength.status, 400);
  const response = await worker.fetch(new Request(url, { method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "image/jpeg", "Content-Length": "12" }, body: "fake" }), {
    HTV_DB: db,
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
