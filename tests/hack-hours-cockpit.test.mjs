import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  checkInAttendee,
  countEventPhotos,
  createEventPhotoRecord,
  getEventCockpit,
  getEventFollowupPacket,
  listEventPhotos,
  normalizeEmergencyContactInput,
  normalizeSignupInput,
  renderEventPageHtml,
  requireOrganizerAccess,
  requireSuperAdminAccess,
  upsertEmergencyContact,
  upsertSignup
} from "../functions/_lib/event-platform.js";
import worker from "../worker.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

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
    assert.doesNotMatch(text, /event_photos[\s\S]*project_id/);
    assert.doesNotMatch(text, /event_photos[\s\S]*submission_id/);
    assert.doesNotMatch(text, /event_photos[\s\S]*participant_user_id/);
  }
});

test("package check script covers all event cockpit route modules", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.check, /functions\/api\/events\/\[slug\]\/checkins\/index\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/events\/\[slug\]\/instances\/\[instanceId\]\/cockpit\/index\.js/);
  assert.match(pkg.scripts.check, /functions\/api\/events\/\[slug\]\/instances\/\[instanceId\]\/photos\/index\.js/);
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

test("admin page defaults to Hack Hours cockpit with roster, contact resolution, event photo upload, and follow-up packet", () => {
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
  assert.ok(html.indexOf("id=\"event-cockpit\"") < html.indexOf("id=\"event-form\""));
  const cockpit = html.slice(html.indexOf("id=\"event-cockpit\""), html.indexOf("id=\"events-admin\""));
  assert.doesNotMatch(cockpit, /School/);
  assert.doesNotMatch(cockpit, /Notes/);
  assert.doesNotMatch(cockpit, /Waiver/);
  assert.doesNotMatch(cockpit, /Project upload/);
  assert.doesNotMatch(cockpit, /projects? or submissions?/i);
  assert.doesNotMatch(cockpit, /participant upload/i);
});
