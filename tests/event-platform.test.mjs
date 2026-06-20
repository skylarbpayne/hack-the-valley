import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addSignupToEmailList,
  checkInAttendee,
  createHelperInterest,
  csvEscape,
  listEvents,
  listHelperInterests,
  normalizeEventInput,
  normalizeHelperInterestInput,
  normalizeSignupInput,
  requireAdmin,
  requireSuperAdminAccess,
  renderEventPageHtml,
  resolveSignupEventInstance,
  searchCheckinCandidates,
  signupsToCsv,
  slugify,
  upsertEvent,
  upsertUser
} from "../functions/_lib/event-platform.js";
import worker from "../worker.js";

function roleAwareAdminDb({ role = "admin", users = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (/FROM user_sessions/.test(sql)) {
            return {
              id: "usr_admin",
              email: "admin@example.com",
              name: "Admin User",
              session_id: "ses_admin",
              session_expires_at: "2099-01-01T00:00:00.000Z"
            };
          }
          if (/FROM roles/.test(sql)) {
            return role && this.args.includes(role) ? { role, scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" } : null;
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          if (/FROM users/.test(sql)) return { results: users };
          return { results: [] };
        }
      };
    }
  };
}

test("slugify creates stable event slugs", () => {
  assert.equal(slugify("Hack Hours at Panera!"), "hack-hours-at-panera");
  assert.equal(slugify("  AI & Career Night  "), "ai-and-career-night");
});

test("event input validates required fields and statuses", () => {
  const ok = normalizeEventInput({
    title: "Hack Hours at Panera",
    status: "open",
    capacity: "30"
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.event.slug, "hack-hours-at-panera");
  assert.equal(ok.event.capacity, 30);

  const bad = normalizeEventInput({ title: "", slug: "Bad Slug", status: "published" });
  assert.match(bad.errors.join(";"), /title is required/);
  assert.match(bad.errors.join(";"), /slug/);
  assert.match(bad.errors.join(";"), /status/);
});

test("event input supports optional capacity, photos, editable page content, and recurrence metadata", () => {
  const { event, errors } = normalizeEventInput({
    title: "Hack the Valley 2026",
    status: "closed",
    capacity: "",
    image_url: "/images/events/2026/hero.jpg",
    page_content: "Agenda, parking, eligibility, and recap links live here.",
    recurrence_rule: { frequency: "yearly", interval: 1 }
  });

  assert.deepEqual(errors, []);
  assert.equal(event.slug, "hack-the-valley-2026");
  assert.equal(event.capacity, null);
  assert.equal(event.image_url, "/images/events/2026/hero.jpg");
  assert.equal(event.page_content, "Agenda, parking, eligibility, and recap links live here.");
  assert.equal(event.recurrence_rule_json, JSON.stringify({ frequency: "yearly", interval: 1 }));
});

test("upsertEvent persists event page fields", async () => {
  const prepared = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          prepared.push(this);
          return this;
        },
        async run() {
          return { success: true };
        },
        async first() {
          return {
            slug: this.args[0],
            title: "Hack the Valley 2026",
            image_url: "/images/events/2026/hero.jpg",
            page_content: "Editable event page body",
            recurrence_rule_json: JSON.stringify({ frequency: "yearly" })
          };
        }
      };
      return statement;
    }
  };

  await upsertEvent(db, {
    title: "Hack the Valley 2026",
    image_url: "/images/events/2026/hero.jpg",
    page_content: "Editable event page body",
    recurrence_rule: { frequency: "yearly" }
  });

  assert.match(prepared[0].sql, /image_url/);
  assert.match(prepared[0].sql, /page_content/);
  assert.doesNotMatch(prepared[0].sql, /content_before/);
  assert.doesNotMatch(prepared[0].sql, /content_after/);
  assert.match(prepared[0].sql, /recurrence_rule_json/);
  assert.ok(prepared[0].args.includes("/images/events/2026/hero.jpg"));
  assert.ok(prepared[0].args.includes("Editable event page body"));
  assert.ok(prepared[0].args.includes(JSON.stringify({ frequency: "yearly" })));
});

test("upsertUser gives users their own ID space and never uses email as ID", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          statements.push(this);
          return this;
        },
        async run() {
          return { success: true };
        },
        async first() {
          return {
            id: this.args[0]?.startsWith?.("usr_") ? this.args[0] : "usr_existing",
            email: "ada@example.com",
            name: "Ada Lovelace"
          };
        }
      };
      return statement;
    }
  };

  const user = await upsertUser(db, {
    email: " ADA@example.COM ",
    name: "Ada Lovelace",
    first_name: "Ada",
    last_name: "Lovelace"
  });

  assert.match(user.id, /^usr_/);
  assert.notEqual(user.id, "ada@example.com");
  assert.match(statements[0].sql, /INSERT INTO users/);
  assert.match(statements[0].sql, /ON CONFLICT\(email\)/);
});

test("signup input normalizes email and legacy school field", () => {
  const { signup, errors } = normalizeSignupInput({
    name: "Ada Lovelace",
    email: " ADA@example.COM ",
    university: "CSUB",
    emergency_contact_name: "Charles Babbage",
    emergency_contact_phone: "661-555-0100",
    email_list_opt_in: true
  }, "hack-hours-panera");

  assert.deepEqual(errors, []);
  assert.equal(signup.email, "ada@example.com");
  assert.equal(signup.first_name, "Ada");
  assert.equal(signup.last_name, "Lovelace");
  assert.equal(signup.school, "CSUB");
  assert.equal(signup.email_list_opt_in, 1);
});

test("signup input requires name and valid email", () => {
  const { errors } = normalizeSignupInput({ name: "", email: "bad" }, "hack-hours-panera");
  assert.match(errors.join(";"), /name is required/);
  assert.match(errors.join(";"), /valid email is required/);
});

test("helper interest input captures volunteer leads without treating them as participants", () => {
  const { helperInterest, errors } = normalizeHelperInterestInput({
    role_interest: "Workshop Host",
    availability: "Weeknights",
    skills: "AI mentoring and sponsor intros",
    consent_contact: "yes"
  }, {
    id: "usr_helper",
    email: "HELPER@Example.COM",
    name: "Helper Person"
  });

  assert.deepEqual(errors, []);
  assert.equal(helperInterest.user_id, "usr_helper");
  assert.equal(helperInterest.name, "Helper Person");
  assert.equal(helperInterest.email, "helper@example.com");
  assert.equal(helperInterest.role_interest, "workshop_host");
  assert.equal(helperInterest.status, "new");
});

test("helper interest input requires contact, allowed role, and consent", () => {
  const { errors } = normalizeHelperInterestInput({ name: "No Consent", role_interest: "speaker" });
  assert.match(errors.join(";"), /email or contact method is required/);
  assert.match(errors.join(";"), /role interest must be/);
  assert.match(errors.join(";"), /consent to be contacted is required/);
});

test("helper interest records persist privately and list only through the admin helper", async () => {
  const rows = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          assert.match(sql, /INSERT INTO helper_interests/);
          const [id, created_at, updated_at, user_id, name, email, contact, role_interest, availability, event_interest, skills, notes, consent_contact, source, status, metadata_json] = this.args;
          rows.push({ id, created_at, updated_at, user_id, name, email, contact, role_interest, availability, event_interest, skills, notes, consent_contact, source, status, metadata_json });
          return { success: true };
        },
        async first() {
          assert.match(sql, /SELECT \* FROM helper_interests WHERE id = \?/);
          return rows.find((row) => row.id === this.args[0]);
        },
        async all() {
          assert.match(sql, /FROM helper_interests hi/);
          return { results: rows.map((row) => ({ ...row, account_email: null, account_name: null })) };
        }
      };
    }
  };

  const saved = await createHelperInterest(db, {
    id: "hlp_test",
    name: "Ada Helper",
    email: "ada@example.com",
    role_interest: "mentor",
    skills: "Web and AI",
    notes: "Can judge finals",
    consent_contact: true,
    metadata: { source_detail: "test" }
  });
  assert.equal(saved.id, "hlp_test");
  assert.equal(saved.email, "ada@example.com");

  const [listed] = await listHelperInterests(db);
  assert.equal(listed.email, "ada@example.com");
  assert.equal(listed.consent_contact, true);
  assert.deepEqual(listed.metadata, { source_detail: "test" });
});

test("worker exposes helper interest POST publicly but keeps the list admin-only", async () => {
  const rows = [];
  const db = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          if (/INSERT INTO helper_interests/.test(sql)) {
            const [id, created_at, updated_at, user_id, name, email, contact, role_interest, availability, event_interest, skills, notes, consent_contact, source, status, metadata_json] = this.args;
            rows.push({ id, created_at, updated_at, user_id, name, email, contact, role_interest, availability, event_interest, skills, notes, consent_contact, source, status, metadata_json });
            return { success: true };
          }
          throw new Error(`Unexpected run() query: ${sql}`);
        },
        async first() {
          if (/SELECT \* FROM helper_interests WHERE id = \?/.test(sql)) return rows.find((row) => row.id === this.args[0]);
          if (/FROM user_sessions/.test(sql)) {
            return {
              id: "usr_admin",
              email: "admin@example.com",
              name: "Admin User",
              session_id: "ses_admin",
              session_expires_at: "2099-01-01T00:00:00.000Z"
            };
          }
          if (/FROM roles/.test(sql)) return { role: "admin", scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" };
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          if (/FROM helper_interests hi/.test(sql)) return { results: rows.map((row) => ({ ...row, account_email: null, account_name: null })) };
          return { results: [] };
        }
      };
    }
  };

  const postResponse = await worker.fetch(new Request("https://hackthevalley.org/api/helper-interest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Ada Helper", email: "ada@example.com", role_interest: "mentor", consent_contact: true })
  }), { HTV_DB: db }, {});
  assert.equal(postResponse.status, 201);
  const publicBody = await postResponse.json();
  assert.equal(publicBody.success, true);
  assert.equal(publicBody.helper_interest.role_interest, "mentor");
  assert.equal(publicBody.helper_interest.email, undefined);
  assert.equal(publicBody.helper_interest.contact, undefined);
  assert.equal(publicBody.helper_interest.name, undefined);

  const unauthorizedList = await worker.fetch(new Request("https://hackthevalley.org/api/helper-interest"), { HTV_DB: db }, {});
  assert.equal(unauthorizedList.status, 401);

  const adminList = await worker.fetch(new Request("https://hackthevalley.org/api/helper-interest", { headers: { cookie: "htv_session=test-session" } }), { HTV_DB: db }, {});
  assert.equal(adminList.status, 200);
  const adminBody = await adminList.json();
  assert.equal(adminBody.helper_interests[0].email, "ada@example.com");
});

test("Resend sync creates/updates a contact; per-event signup state stays in the app D1 database", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await addSignupToEmailList(
      { RESEND_API_KEY: "re_test" },
      { email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", email_list_opt_in: 1 },
      { slug: "hack-hours-panera", title: "Hack Hours at Panera" }
    );
    assert.equal(result.status, "synced");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/contacts");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.email, "ada@example.com");
    assert.equal(body.properties, undefined);
    assert.equal(body.unsubscribed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Resend sync patches existing contacts without forcing resubscribe", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return new Response("duplicate", { status: 409 });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await addSignupToEmailList(
      { RESEND_API_KEY: "re_test" },
      { email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", email_list_opt_in: 1 },
      { slug: "hack-hours-panera", title: "Hack Hours at Panera" }
    );
    assert.equal(result.status, "synced");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://api.resend.com/contacts/ada%40example.com");
    assert.equal(calls[1].init.method, "PATCH");
    assert.equal(Object.hasOwn(JSON.parse(calls[1].init.body), "unsubscribed"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Resend sync can skip cleanly when not configured or opted out", async () => {
  assert.deepEqual(
    await addSignupToEmailList({}, { email: "a@example.com", email_list_opt_in: 1 }, { slug: "e", title: "Event" }),
    { status: "skipped_not_configured", detail: "RESEND_API_KEY is not configured" }
  );
  assert.deepEqual(
    await addSignupToEmailList({ RESEND_API_KEY: "re_test" }, { email: "a@example.com", email_list_opt_in: 0 }, { slug: "e", title: "Event" }),
    { status: "skipped_opt_out", detail: "Registrant opted out of community email list" }
  );
});

test("CSV export includes metadata for event-specific hackathon fields", () => {
  assert.equal(csvEscape('Ada "Countess"'), '"Ada ""Countess"""');
  const csv = signupsToCsv([{
    event_slug: "hack-the-valley-2026",
    name: "Ada",
    email: "ada@example.com",
    notes: "line\nbreak",
    metadata_json: JSON.stringify({ major: "CS", dietary: "vegetarian", tshirt: "M", coc: true })
  }]);
  assert.match(csv, /metadata_json/);
  assert.match(csv, /checked_in_at/);
  assert.match(csv, /"line\nbreak"/);
  assert.match(csv, /"{""major"":""CS"",""dietary"":""vegetarian"",""tshirt"":""M"",""coc"":true}"/);
});

test("admin page is the canonical one-stop admin surface at /admin", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /<title>Hack the Valley Admin<\/title>/);
  assert.match(html, /Create \/ update event/);
  assert.match(html, /Project submissions/);
  assert.match(html, /href="\/admin-submissions"/);
  assert.doesNotMatch(html, /admin-events\.html/);
});

test("admin page gates the full UI behind a signed-in admin role", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="login-panel"/);
  assert.match(html, /id="admin-app"[\s\S]*hidden/);
  assert.match(html, /\/login\/\?next=\/admin/);
  assert.match(html, /api\("\/api\/admin\/me"\)/);
  assert.match(html, /active admin role/);
  assert.match(html, /id="role-admin"/);
  assert.match(html, /\/api\/admin\/roles/);
  assert.match(html, /Admin role grants/);
  assert.doesNotMatch(html, /localStorage\.setItem\("htv_admin_token"/);
  assert.doesNotMatch(html, /id="admin-token"/);
  assert.doesNotMatch(html, /Prefill Hack Hours at Panera/);
});

test("admin role helpers require session roles and keep token bootstrap opt-in only", async () => {
  const sessionRequest = new Request("https://hackthevalley.org/api/users", { headers: { cookie: "htv_session=test-session" } });
  const admin = await requireAdmin(sessionRequest, { HTV_DB: roleAwareAdminDb({ role: "admin" }) });
  assert.equal(admin.role.role, "admin");

  await assert.rejects(
    () => requireSuperAdminAccess(sessionRequest, { HTV_DB: roleAwareAdminDb({ role: "admin" }) }),
    /Forbidden/
  );
  const superAdmin = await requireSuperAdminAccess(sessionRequest, { HTV_DB: roleAwareAdminDb({ role: "super_admin" }) });
  assert.equal(superAdmin.role.role, "super_admin");

  const tokenRequest = new Request("https://hackthevalley.org/api/users", { headers: { Authorization: "Bearer legacy-secret" } });
  await assert.rejects(
    () => requireAdmin(tokenRequest, { HTV_DB: roleAwareAdminDb({ role: null }), HTV_ADMIN_TOKEN: "legacy-secret" }),
    /Unauthorized/
  );
  const bootstrap = await requireAdmin(tokenRequest, {
    HTV_DB: roleAwareAdminDb({ role: null }),
    HTV_ADMIN_TOKEN: "legacy-secret",
    HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED: "1"
  });
  assert.equal(bootstrap.bootstrap, true);
});

test("admin page lists event instances as flat rows without dropdowns", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="users-admin"/);
  assert.match(html, /id="users-list"/);
  assert.match(html, /function loadUsers/);
  assert.match(html, /\/api\/users/);
  assert.match(html, /id="event-signups"/);
  assert.match(html, /function loadEventSignups\(slug, title = slug, instanceId = null/);
  assert.match(html, /params\.set\("instance_id", instanceId\)/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/signups\$\{query\}/);
  assert.match(html, /function eventInstanceRows\(events\)/);
  assert.match(html, /data-signups-row=/);
  assert.match(html, /View signups/);
  assert.match(html, /Export CSV/);
  assert.doesNotMatch(html, /data-instance-select=/);
  assert.doesNotMatch(html, /selectedInstanceFor\(event\)/);
  assert.doesNotMatch(html, /<th[^>]*>School<\/th>/);
  assert.doesNotMatch(html, /<th[^>]*>Notes<\/th>/);
  assert.doesNotMatch(html, /user\.school/);
  assert.doesNotMatch(html, /signup\.school/);
  assert.doesNotMatch(html, /signup\.notes/);
});

test("public event signup form collects name, email, emergency contact, and mailing list opt-in only", () => {
  const html = readFileSync(new URL("../public/events/index.html", import.meta.url), "utf8");
  assert.match(html, /name="emergency_contact_name"/);
  assert.match(html, /name="emergency_contact_phone"/);
  assert.doesNotMatch(html, /School \/ organization/);
  assert.doesNotMatch(html, /name="school"/);
  assert.doesNotMatch(html, /name="notes"/);
  assert.doesNotMatch(html, /Anything we should know/);
});

test("check-in search ranks signed-up attendees first while searching all users", async () => {
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM users u/);
      assert.match(sql, /LEFT JOIN signups s/);
      assert.match(sql, /s\.event_instance_id = \?/);
      assert.match(sql, /lower\(u\.email\) LIKE \?/);
      assert.match(sql, /ORDER BY is_signed_up DESC/);
      return {
        bind(eventInstanceId, likeA, likeB, likeC) {
          assert.equal(eventInstanceId, "inst_hack_hours_20260613");
          assert.equal(likeA, "%ada%");
          assert.equal(likeB, "%ada%");
          assert.equal(likeC, "%ada%");
          return this;
        },
        async all() {
          return {
            results: [
              { id: "usr_signed", email: "ada@example.com", name: "Ada Signed", is_signed_up: 1, signup_id: "sgn_1", checked_in_at: null },
              { id: "usr_global", email: "admiral@example.com", name: "Admiral Global", is_signed_up: 0, signup_id: null, checked_in_at: null }
            ]
          };
        }
      };
    }
  };

  const candidates = await searchCheckinCandidates(db, "hack-hours", { eventInstanceId: "inst_hack_hours_20260613", query: "ada" });
  assert.equal(candidates[0].id, "usr_signed");
  assert.equal(candidates[0].is_signed_up, 1);
  assert.equal(candidates[1].id, "usr_global");
});

test("check-in search defaults to all signups for the selected event instance", async () => {
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM signups s/);
      assert.match(sql, /JOIN users u ON u\.id = s\.user_id/);
      assert.match(sql, /WHERE s\.event_slug = \? AND s\.event_instance_id = \?/);
      assert.doesNotMatch(sql, /lower\(u\.email\) LIKE/);
      return {
        bind(eventSlug, eventInstanceId) {
          assert.equal(eventSlug, "hack-hours");
          assert.equal(eventInstanceId, "inst_hack_hours_20260613");
          return this;
        },
        async all() {
          return {
            results: [
              { id: "usr_signed_a", email: "ada@example.com", name: "Ada Signed", is_signed_up: 1, signup_id: "sgn_1", checked_in_at: null },
              { id: "usr_signed_b", email: "grace@example.com", name: "Grace Signed", is_signed_up: 1, signup_id: "sgn_2", checked_in_at: "2026-06-13T16:00:00.000Z" }
            ]
          };
        }
      };
    }
  };

  const candidates = await searchCheckinCandidates(db, "hack-hours", { eventInstanceId: "inst_hack_hours_20260613", query: "" });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["usr_signed_a", "usr_signed_b"]);
  assert.equal(candidates.every((candidate) => candidate.is_signed_up === 1), true);
});

test("manual attendee check-in can create/signup/check in and stores a checked_in participant event", () => {
  const source = readFileSync(new URL("../functions/_lib/event-platform.js", import.meta.url), "utf8");
  assert.match(source, /export async function checkInAttendee/);
  assert.match(source, /await upsertSignup\(/);
  assert.match(source, /'checked_in'/);
  assert.match(source, /INSERT OR IGNORE INTO event_participant_events/);
  assert.match(source, /event_instance_id/);
});

test("admin check-in can reuse existing users without emergency contact", () => {
  const source = readFileSync(new URL("../functions/_lib/event-platform.js", import.meta.url), "utf8");
  assert.match(source, /normalizeSignupInput\(input, eventSlug, \{ requireEmergencyContact = true \} = \{\}\)/);
  assert.match(source, /requireEmergencyContact: !input\.user_id/);
  assert.match(source, /if \(!input\.user_id\) \{/);
});

test("admin portal exposes event check-in search and manual walk-up form", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="event-checkin"/);
  assert.match(html, /id="checkin-event-title"/);
  assert.match(html, /currentCheckinEvent\.title/);
  assert.match(html, /id="checkin-search"/);
  assert.match(html, /placeholder="Search name or email/);
  assert.match(html, /id="manual-checkin-form"/);
  assert.match(html, /function loadCheckinCandidates/);
  assert.doesNotMatch(html, /if \(!query\) \{/);
  assert.match(html, /No signups match yet/);
  assert.match(html, /loadCheckinCandidates\(\)\.catch/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(currentCheckinEvent\.slug\)\}\/checkins/);
  assert.match(html, /data-checkin-user=/);
  assert.match(html, /Not signed up for this instance yet/);
  assert.match(html, /function setCheckinError/);
  assert.doesNotMatch(html, /data-walkup-user=/);
  assert.doesNotMatch(html, /Use walk-up form/);
  assert.doesNotMatch(html, /function prefillManualCheckin/);
  assert.doesNotMatch(html, /checkInUser\(\{ user_id: button\.dataset\.checkinUser \}\)\.catch\(\(\) => \{\}\)/);
});

test("admin event form supports image uploads, auto-populates slug, and avoids async currentTarget reset bug", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /function slugify/);
  assert.match(html, /id="event-image-file"/);
  assert.match(html, /accept="image\/\*"/);
  assert.match(html, /id="upload-event-image"/);
  assert.match(html, /function uploadEventImage/);
  assert.match(html, /async function ensureEventImageUploaded/);
  assert.match(html, /await ensureEventImageUploaded\(form\)/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/image/);
  assert.match(html, /name="image_url"/);
  assert.match(html, /name="page_content"/);
  assert.doesNotMatch(html, /name="content_before"/);
  assert.doesNotMatch(html, /name="content_after"/);
  assert.match(html, /name="recurrence_rule"/);
  assert.match(html, /capacity" type="number"[^>]+placeholder="Leave blank/);
  assert.match(html, /const form = event\.currentTarget/);
  assert.match(html, /form\.reset\(\)/);
  assert.doesNotMatch(html, /event\.currentTarget\.reset\(\)/);
});

test("event schema has users and user-linked signups instead of email-as-identity", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/0004_users_and_user_signups.sql", import.meta.url), "utf8");

  assert.match(schema, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(schema, /id TEXT PRIMARY KEY/);
  assert.match(schema, /email TEXT NOT NULL UNIQUE/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS signups/);
  assert.match(schema, /user_id TEXT NOT NULL REFERENCES users\(id\)/);
  assert.match(schema, /event_instance_id TEXT REFERENCES event_instances\(id\)/);
  assert.match(schema, /UNIQUE\(event_instance_id, user_id\)/);
  assert.doesNotMatch(schema, /UNIQUE\(event_slug, email\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(migration, /INSERT OR IGNORE INTO users/);
  assert.match(migration, /ALTER TABLE signups_new RENAME TO signups/);
});

test("event schema has event-sourced participant state for check-in and future attendance facts", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/0005_event_participant_events.sql", import.meta.url), "utf8");
  const instanceMigration = readFileSync(new URL("../migrations/0006_event_instances_and_clean_hack_hours_slug.sql", import.meta.url), "utf8");
  for (const text of [schema, migration]) {
    assert.match(text, /CREATE TABLE IF NOT EXISTS event_participant_events/);
    assert.match(text, /event_slug TEXT NOT NULL REFERENCES events\(slug\)/);
    assert.match(text, /user_id TEXT NOT NULL REFERENCES users\(id\)/);
    assert.match(text, /event_type TEXT NOT NULL/);
    assert.match(text, /data_json TEXT/);
    assert.match(text, /occurred_at TEXT NOT NULL/);
  }
  assert.match(migration, /INSERT OR IGNORE INTO event_participant_events/);
  assert.match(migration, /'signed_up'/);
  assert.match(schema, /event_instance_id TEXT REFERENCES event_instances\(id\)/);
  assert.match(instanceMigration, /event_instance_id TEXT REFERENCES event_instances\(id\)/);
  assert.match(schema, /CREATE VIEW IF NOT EXISTS event_participant_current_state/);
});

test("event schema supports reusable Hack Hours slug with concrete instances and scrubs generated suffix", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/0006_event_instances_and_clean_hack_hours_slug.sql", import.meta.url), "utf8");
  const admin = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  const publicEvents = readFileSync(new URL("../public/events/index.html", import.meta.url), "utf8");

  assert.match(schema, /CREATE TABLE IF NOT EXISTS event_instances/);
  assert.match(schema, /event_slug TEXT NOT NULL REFERENCES events\(slug\)/);
  assert.match(schema, /instance_key TEXT NOT NULL/);
  assert.match(schema, /UNIQUE\(event_slug, instance_key\)/);
  assert.match(migration, /'hack-hours', title/);
  assert.match(migration, /WHERE slug = 'hack-hours' \|\| '-1'/i);
  assert.match(migration, /DELETE FROM events WHERE slug = 'hack-hours' \|\| '-1'/i);
  assert.match(migration, /INSERT OR IGNORE INTO event_instances/);
  assert.match(admin, /eventInstanceRows\(events\)/);
  assert.match(admin, /data-cockpit-row=/);
  const oldSlugPattern = new RegExp("hack-hours" + "-1");
  assert.doesNotMatch(schema, oldSlugPattern);
  assert.doesNotMatch(migration, oldSlugPattern);
  assert.doesNotMatch(admin, oldSlugPattern);
  assert.doesNotMatch(publicEvents, oldSlugPattern);
});

test("event list includes past and active instances for admin selection", async () => {
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          if (/FROM events e/.test(sql)) {
            return { results: [{ slug: "hack-hours", title: "Hack Hours", active_instance_id: "inst_hack_hours_20260620", active_instance_key: "2026-06-20", instance_count: 2 }] };
          }
          if (/FROM event_instances/.test(sql)) {
            assert.equal(this.args[0], "hack-hours");
            return { results: [
              { id: "inst_hack_hours_20260613", instance_key: "2026-06-13", status: "closed" },
              { id: "inst_hack_hours_20260620", instance_key: "2026-06-20", status: "open" }
            ] };
          }
          return { results: [] };
        }
      };
    }
  };

  const events = await listEvents(db, { includeArchived: true });
  assert.deepEqual(events[0].instances.map((instance) => instance.instance_key), ["2026-06-13", "2026-06-20"]);
});

test("signup resolution chooses an open concrete event instance for a reusable slug", async () => {
  const sqls = [];
  const db = {
    prepare(sql) {
      sqls.push(sql);
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          assert.equal(this.args[0], "hack-hours");
          return { id: "inst_hack_hours_20260614", event_slug: "hack-hours", status: "open" };
        }
      };
    }
  };

  const instance = await resolveSignupEventInstance(db, "hack-hours");
  assert.equal(instance.id, "inst_hack_hours_20260614");
  assert.match(sqls.join("\n"), /FROM event_instances/);
  assert.match(sqls.join("\n"), /status = 'open'/);
});

test("event signup writes signups and participant events against a concrete instance", () => {
  const source = readFileSync(new URL("../functions/_lib/event-platform.js", import.meta.url), "utf8");
  assert.match(source, /event_instance_id/);
  assert.match(source, /ON CONFLICT\(event_instance_id, user_id\)/);
  assert.match(source, /INSERT INTO signups/);
  assert.match(source, /INSERT OR IGNORE INTO event_participant_events/);
  assert.match(source, /savedSignup\.event_instance_id/);
});

test("event schema has editable page content and a forward cleanup migration", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/0003_event_page_content.sql", import.meta.url), "utf8");
  for (const column of ["image_url", "page_content", "recurrence_rule_json"]) {
    assert.match(schema, new RegExp(`${column}\\s+TEXT`));
  }
  assert.doesNotMatch(schema, /content_before\s+TEXT/);
  assert.doesNotMatch(schema, /content_after\s+TEXT/);
  assert.match(migration, /ADD COLUMN page_content TEXT/i);
  assert.match(migration, /DROP COLUMN content_before/i);
  assert.match(migration, /DROP COLUMN content_after/i);
});

test("renderEventPageHtml returns a real event-specific page, not the events listing shell", () => {
  const html = renderEventPageHtml({
    slug: "hack-the-valley-2026",
    title: "Hack the Valley 2026",
    description: "Build in Bakersfield.",
    image_url: "/api/events/hack-the-valley-2026/image?key=event-images%2Fhack-the-valley-2026%2Fhero.png",
    page_content: "Agenda, prizes, venue details, and what to bring.",
    status: "open",
    starts_at: "2026-07-01T17:00:00.000Z",
    venue_name: "Bakersfield College"
  });

  assert.match(html, /data-event-detail-page="hack-the-valley-2026"/);
  assert.match(html, /Hack the Valley 2026/);
  assert.match(html, /Agenda, prizes, venue details, and what to bring/);
  assert.match(html, /<img[^>]+event-hero-image/);
  assert.match(html, /<form[^>]+id="signup-form"/);
  assert.doesNotMatch(html, /School \/ org/i);
  assert.doesNotMatch(html, /School \/ organization/i);
  assert.doesNotMatch(html, /name="school"/);
  assert.doesNotMatch(html, /Notes/i);
  assert.doesNotMatch(html, /name="notes"/);
  assert.doesNotMatch(html, /name="year"/);
  assert.doesNotMatch(html, /id="upcoming-events-panel"/);
});

test("public events page uses clickable cards, signup CTAs, and a true event-detail mode", () => {
  const html = readFileSync(new URL("../public/events/index.html", import.meta.url), "utf8");
  assert.match(html, /event\.image_url/);
  assert.match(html, /id="events-hero"/);
  assert.match(html, /id="events-overview-grid"/);
  assert.match(html, /isEventDetailPath/);
  assert.match(html, /Event page/);
  assert.match(html, /event-card/);
  assert.match(html, /data-event-url="\/events\/\$\{encodeURIComponent\(event\.slug\)\}"/);
  assert.match(html, /#signup/);
  assert.match(html, />Sign up<\/a>/);
  assert.match(html, /event-page-content/);
  assert.match(html, /selected\.page_content/);
  assert.match(html, /pathEventMatch/);
  assert.doesNotMatch(html, /event-content-before/);
  assert.doesNotMatch(html, /event-content-after/);
});

test("worker routes dynamic event APIs on the deployed Worker surface", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          if (/FROM events e/.test(sql)) {
            return { results: [{ slug: "hack-hours-panera", title: "Hack Hours at Panera", status: "open" }] };
          }
          if (/FROM event_instances/.test(sql)) return { results: [{ id: "inst_hack_hours_panera", instance_key: "2026-06-20", status: "open" }] };
          return { results: [] };
        }
      };
    }
  };

  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/events", { method: "GET" }),
    { HTV_DB: fakeDb, ASSETS: { fetch: () => new Response("static miss", { status: 404 }) } },
    {}
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.events[0].slug, "hack-hours-panera");
});

test("worker exposes admin-only users API", async () => {
  const fakeDb = roleAwareAdminDb({
    role: "admin",
    users: [{ id: "usr_1", email: "ada@example.com", name: "Ada", created_at: "2026-01-01T00:00:00.000Z" }]
  });

  const unauthorized = await worker.fetch(
    new Request("https://hackthevalley.org/api/users", { method: "GET" }),
    { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" },
    {}
  );
  assert.equal(unauthorized.status, 401);

  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/users", { method: "GET", headers: { cookie: "htv_session=test-session" } }),
    { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" },
    {}
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.users[0].id, "usr_1");
  assert.equal(body.users[0].email, "ada@example.com");
});

test("wrangler runs the Worker before event page asset routing", () => {
  const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /binding\s*=\s*"ASSETS"/);
  assert.match(config, /run_worker_first\s*=\s*\[[^\]]*"\/api\/\*"[^\]]*"\/events\/\*"[^\]]*\]/);
});

test("worker renders real per-event HTML from D1 for /events/<slug>", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        bind(slug) {
          assert.match(sql, /FROM events WHERE slug = \?/);
          assert.equal(slug, "hack-the-valley-2026");
          return this;
        },
        async first() {
          return {
            slug: "hack-the-valley-2026",
            title: "Hack the Valley 2026",
            description: "Build in Bakersfield.",
            status: "open",
            image_url: "/image.png",
            page_content: "This is the real event page body."
          };
        }
      };
    }
  };

  const response = await worker.fetch(
    new Request("https://hackthevalley.org/events/hack-the-valley-2026", { method: "GET" }),
    { HTV_DB: fakeDb },
    {}
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-event-detail-page="hack-the-valley-2026"/);
  assert.match(html, /This is the real event page body/);
  assert.doesNotMatch(html, /id="upcoming-events-panel"/);
});

test("event signup writes an append-only signed_up participant event", () => {
  const source = readFileSync(new URL("../functions/_lib/event-platform.js", import.meta.url), "utf8");
  assert.match(source, /INSERT OR IGNORE INTO event_participant_events/);
  assert.match(source, /'signed_up'/);
  assert.match(source, /evt_\$\{savedSignup\.id\}_signed_up/);
});

test("Resend import script pre-populates the users table without email IDs", () => {
  const script = readFileSync(new URL("../scripts/import-resend-users.mjs", import.meta.url), "utf8");
  assert.match(script, /RESEND_API_KEY/);
  assert.match(script, /RESEND_AUDIENCE_ID/);
  assert.match(script, /INSERT INTO users/);
  assert.match(script, /usr_/);
  assert.match(script, /ON CONFLICT\(email\)/);
  assert.match(script, /wrangler d1 execute HTV_DB --remote/);
});

test("worker accepts admin event image uploads and serves uploaded event images publicly", async () => {
  const stored = new Map();
  const env = {
    HTV_DB: roleAwareAdminDb({ role: "admin" }),
    HTV_ADMIN_TOKEN: "secret",
    MAX_UPLOAD_MB: "1",
    SUBMISSIONS_MEDIA: {
      async put(key, body, options) {
        stored.set(key, { body: await new Response(body).text(), options });
      },
      async get(key) {
        const value = stored.get(key);
        if (!value) return null;
        return {
          body: value.body,
          httpEtag: "etag-test",
          customMetadata: value.options.customMetadata,
          writeHttpMetadata(headers) {
            headers.set("content-type", value.options.httpMetadata.contentType);
          }
        };
      }
    }
  };

  const uploadResponse = await worker.fetch(
    new Request("https://hackthevalley.org/api/events/hack-hours-panera/image?filename=hero.png", {
      method: "POST",
      headers: { cookie: "htv_session=test-session", "Content-Type": "image/png", "X-Filename": "hero.png" },
      body: "fake image"
    }),
    env,
    {}
  );
  assert.equal(uploadResponse.status, 200);
  const upload = await uploadResponse.json();
  assert.match(upload.image_url, /^\/api\/events\/hack-hours-panera\/image\?key=/);
  assert.match(upload.image_key, /^event-images\/hack-hours-panera\//);

  const imageResponse = await worker.fetch(
    new Request(`https://hackthevalley.org${upload.image_url}`, { method: "GET" }),
    env,
    {}
  );
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(await imageResponse.text(), "fake image");
});
