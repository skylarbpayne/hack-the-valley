import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addSignupToEmailList,
  csvEscape,
  normalizeEventInput,
  normalizeSignupInput,
  signupsToCsv,
  slugify,
  upsertEvent
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

test("event input supports optional capacity, photos, page content, and recurrence metadata", () => {
  const { event, errors } = normalizeEventInput({
    title: "Hack the Valley 2026",
    status: "closed",
    capacity: "",
    image_url: "/images/events/2026/hero.jpg",
    content_before: "Bring your laptop and check in at 9am.",
    content_after: "Projects, photos, survey, and sponsor recap live here after the event.",
    recurrence_rule: { frequency: "yearly", interval: 1 }
  });

  assert.deepEqual(errors, []);
  assert.equal(event.slug, "hack-the-valley-2026");
  assert.equal(event.capacity, null);
  assert.equal(event.image_url, "/images/events/2026/hero.jpg");
  assert.equal(event.content_before, "Bring your laptop and check in at 9am.");
  assert.equal(event.content_after, "Projects, photos, survey, and sponsor recap live here after the event.");
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
            content_before: "Before copy",
            content_after: "After copy",
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
    content_before: "Before copy",
    content_after: "After copy",
    recurrence_rule: { frequency: "yearly" }
  });

  assert.match(prepared[0].sql, /image_url/);
  assert.match(prepared[0].sql, /content_before/);
  assert.match(prepared[0].sql, /content_after/);
  assert.match(prepared[0].sql, /recurrence_rule_json/);
  assert.ok(prepared[0].args.includes("/images/events/2026/hero.jpg"));
  assert.ok(prepared[0].args.includes("Before copy"));
  assert.ok(prepared[0].args.includes("After copy"));
  assert.ok(prepared[0].args.includes(JSON.stringify({ frequency: "yearly" })));
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

test("admin event form auto-populates slug and avoids async currentTarget reset bug", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /function slugify/);
  assert.match(html, /name="image_url"/);
  assert.match(html, /name="content_before"/);
  assert.match(html, /name="content_after"/);
  assert.match(html, /name="recurrence_rule"/);
  assert.match(html, /capacity" type="number"[^>]+placeholder="Leave blank/);
  assert.match(html, /const form = event\.currentTarget/);
  assert.match(html, /form\.reset\(\)/);
  assert.doesNotMatch(html, /event\.currentTarget\.reset\(\)/);
});

test("event schema has page fields and a forward migration for existing D1 databases", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/0002_event_page_fields.sql", import.meta.url), "utf8");
  for (const column of ["image_url", "content_before", "content_after", "recurrence_rule_json"]) {
    assert.match(schema, new RegExp(`${column}\\s+TEXT`));
    assert.match(migration, new RegExp(`ADD COLUMN ${column} TEXT`, "i"));
  }
});

test("public events page can render event photos and before/after page content", () => {
  const html = readFileSync(new URL("../public/events/index.html", import.meta.url), "utf8");
  assert.match(html, /event\.image_url/);
  assert.match(html, /event-content-before/);
  assert.match(html, /event-content-after/);
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
