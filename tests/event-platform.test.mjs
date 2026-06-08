import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addSignupToEmailList,
  csvEscape,
  normalizeEventInput,
  normalizeSignupInput,
  renderEventPageHtml,
  resolveSignupEventInstance,
  signupsToCsv,
  slugify,
  upsertEvent,
  upsertUser
} from "../functions/_lib/event-platform.js";
import worker from "../worker.js";

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

test("admin page gates the full UI behind a saved admin login", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="login-panel"/);
  assert.match(html, /id="admin-app"[\s\S]*hidden/);
  assert.match(html, /document\.cookie = `htv_admin_logged_in=1/);
  assert.match(html, /localStorage\.setItem\("htv_admin_token"/);
  assert.doesNotMatch(html, /Prefill Hack Hours at Panera/);
});

test("admin page can list users and per-event signups without school/org or notes clutter", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="users-admin"/);
  assert.match(html, /id="users-list"/);
  assert.match(html, /function loadUsers/);
  assert.match(html, /\/api\/users/);
  assert.match(html, /id="event-signups"/);
  assert.match(html, /function loadEventSignups/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/signups/);
  assert.match(html, /data-signups=/);
  assert.doesNotMatch(html, /<th[^>]*>School<\/th>/);
  assert.doesNotMatch(html, /<th[^>]*>Notes<\/th>/);
  assert.doesNotMatch(html, /user\.school/);
  assert.doesNotMatch(html, /signup\.school/);
  assert.doesNotMatch(html, /signup\.notes/);
});

test("public event signup form keeps only name, email, and mailing list opt-in", () => {
  const html = readFileSync(new URL("../public/events/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /School \/ organization/);
  assert.doesNotMatch(html, /name="school"/);
  assert.doesNotMatch(html, /name="notes"/);
  assert.doesNotMatch(html, /Anything we should know/);
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
  const oldSlugPattern = new RegExp("hack-hours" + "-1");
  assert.doesNotMatch(schema, oldSlugPattern);
  assert.doesNotMatch(migration, oldSlugPattern);
  assert.doesNotMatch(admin, oldSlugPattern);
  assert.doesNotMatch(publicEvents, oldSlugPattern);
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
        all: async () => {
          assert.match(sql, /FROM events/);
          return { results: [{ slug: "hack-hours-panera", title: "Hack Hours at Panera", status: "open" }] };
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
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async all() {
          assert.match(sql, /FROM users/);
          return { results: [{ id: "usr_1", email: "ada@example.com", name: "Ada", created_at: "2026-01-01T00:00:00.000Z" }] };
        }
      };
    }
  };

  const unauthorized = await worker.fetch(
    new Request("https://hackthevalley.org/api/users", { method: "GET" }),
    { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" },
    {}
  );
  assert.equal(unauthorized.status, 401);

  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/users", { method: "GET", headers: { Authorization: "Bearer secret" } }),
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
      headers: { Authorization: "Bearer secret", "Content-Type": "image/png", "X-Filename": "hero.png" },
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
