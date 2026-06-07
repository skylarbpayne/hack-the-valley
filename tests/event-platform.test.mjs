import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addSignupToEmailList,
  csvEscape,
  normalizeEventInput,
  normalizeSignupInput,
  signupsToCsv,
  slugify
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

test("CSV export escapes operationally annoying values", () => {
  assert.equal(csvEscape('Ada "Countess"'), '"Ada ""Countess"""');
  const csv = signupsToCsv([{ event_slug: "e", name: "Ada", email: "ada@example.com", notes: "line\nbreak" }]);
  assert.match(csv, /"line\nbreak"/);
});
test("admin page is the canonical one-stop admin surface at /admin", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /<title>Hack the Valley Admin<\/title>/);
  assert.match(html, /Create \/ update event/);
  assert.match(html, /Project submissions/);
  assert.match(html, /href="\/admin-submissions"/);
  assert.doesNotMatch(html, /admin-events\.html/);
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
    { SUBMISSIONS_DB: fakeDb, ASSETS: { fetch: () => new Response("static miss", { status: 404 }) } },
    {}
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.events[0].slug, "hack-hours-panera");
});
