import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { onRequestPost as createEventRoute } from "../functions/api/events/index.js";
import { onRequestPatch as updateEventRoute } from "../functions/api/events/[slug].js";
import {
  prepareEventImageUploadFromAdminRoute,
  prepareEventPhotoUploadFromOrganizerRoute,
  trustedEventAdminProvenance
} from "../functions/_lib/domain/events.js";

const ADMIN_USER = {
  id: "usr_admin",
  email: "admin@example.com",
  name: "Admin User",
  session_id: "ses_admin",
  session_expires_at: "2099-01-01T00:00:00.000Z"
};

function createAdminEventDb({ currentUser = ADMIN_USER, role = "admin", events = [] } = {}) {
  const state = {
    events: new Map(events.map((event) => [event.slug, {
      status: "open",
      instance_count: 0,
      active_instance_id: null,
      active_instance_key: null,
      ...event
    }])),
    instances: new Map(),
    eventWrites: [],
    instanceWrites: [],
    audits: []
  };

  return {
    state,
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM user_sessions/.test(sql)) return currentUser;
          if (/FROM roles/.test(sql)) {
            return currentUser && role && this.args.includes(role)
              ? { role, scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" }
              : null;
          }
          if (/FROM events\s+WHERE slug = \?/.test(sql)) {
            return state.events.get(this.args[0]) || null;
          }
          if (/SELECT \* FROM event_instances WHERE id = \?/.test(sql)) {
            return state.instances.get(this.args[0]) || null;
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          if (/FROM events e/.test(sql)) return { results: [...state.events.values()] };
          if (/FROM event_instances WHERE event_slug = \?/.test(sql)) return { results: [...state.instances.values()].filter((row) => row.event_slug === this.args[0]) };
          if (/FROM event_instances/.test(sql)) return { results: [...state.instances.values()] };
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO events/.test(sql)) {
            const [slug, title, description, startsAt, endsAt, venueName, venueAddress, capacity, status, imageUrl, pageContent, signupFieldsJson, recurrenceRuleJson, createdAt, updatedAt] = this.args;
            const existing = state.events.get(slug) || {};
            const row = {
              ...existing,
              slug,
              title,
              description,
              starts_at: startsAt,
              ends_at: endsAt,
              venue_name: venueName,
              venue_address: venueAddress,
              capacity,
              status,
              image_url: imageUrl,
              page_content: pageContent,
              signup_fields_json: signupFieldsJson,
              recurrence_rule_json: recurrenceRuleJson,
              created_at: existing.created_at || createdAt,
              updated_at: updatedAt,
              instance_count: existing.instance_count || 0,
              active_instance_id: existing.active_instance_id || null,
              active_instance_key: existing.active_instance_key || null
            };
            state.events.set(slug, row);
            state.eventWrites.push({ sql, args: this.args, row });
            return { success: true };
          }
          if (/INSERT INTO event_instances/.test(sql)) {
            const [id, eventSlug, instanceKey, title, startsAt, endsAt, venueName, venueAddress, capacity, status, metadataJson, createdAt, updatedAt] = this.args;
            const row = { id, event_slug: eventSlug, instance_key: instanceKey, title, starts_at: startsAt, ends_at: endsAt, venue_name: venueName, venue_address: venueAddress, capacity, status, metadata_json: metadataJson, created_at: createdAt, updated_at: updatedAt };
            state.instances.set(id, row);
            state.instanceWrites.push({ sql, args: this.args, row });
            return { success: true };
          }
          if (/UPDATE event_instances SET/.test(sql)) {
            const [title, startsAt, endsAt, venueName, venueAddress, capacity, status, updatedAt, id] = this.args;
            state.instances.set(id, { ...state.instances.get(id), title, starts_at: startsAt, ends_at: endsAt, venue_name: venueName, venue_address: venueAddress, capacity, status, updated_at: updatedAt });
            state.instanceWrites.push({ sql, args: this.args, row: state.instances.get(id) });
            return { success: true };
          }
          if (/UPDATE event_plan_anchors SET/.test(sql)) return { success: true };
          if (/INSERT INTO audit_events/.test(sql)) {
            state.audits.push({ sql, args: this.args, metadata: JSON.parse(this.args[7] || "{}") });
            return { success: true };
          }
          if (/INSERT INTO admin_audit_events/.test(sql)) {
            state.audits.push({ sql, args: this.args, metadata: JSON.parse(this.args[8] || "{}") });
            return { success: true };
          }
          throw new Error(`Unexpected run() query: ${sql}`);
        }
      };
    }
  };
}

function adminRequest(url, { method = "POST", body = {} } = {}) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", cookie: "htv_session=test-session" },
    body: JSON.stringify(body)
  });
}

test("event admin create route writes through Events domain and preserves response shape", async () => {
  const db = createAdminEventDb();
  const response = await createEventRoute({
    request: adminRequest("https://hackthevalley.org/api/events", {
      body: {
        title: "Milestone Demo Hours",
        status: "open",
        venue_address: "2020 Eye street",
        source: "forged-source",
        actor: "usr_attacker",
        provenance: { source: "forged" },
        admin: { id: "usr_attacker" }
      }
    }),
    env: { HTV_DB: db },
    params: {}
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["event", "success"]);
  assert.equal(body.success, true);
  assert.equal(body.event.slug, "milestone-demo-hours");
  assert.equal(body.event.venue_address, "2020 Eye street");
  assert.equal(body.event.source, undefined);
  assert.equal(body.event.actor, undefined);
  assert.equal(db.state.eventWrites.length, 1);
  assert.equal(db.state.eventWrites[0].args.includes("forged-source"), false);
  assert.equal(db.state.audits.length, 1);
  assert.equal(db.state.audits[0].args[2], "usr_admin");
  assert.equal(db.state.audits[0].args[3], "event");
  assert.equal(db.state.audits[0].args[4], "milestone-demo-hours");
  assert.equal(db.state.audits[0].metadata.source, "admin");
  assert.equal(db.state.audits[0].metadata.route, "events.index.post");
  assert.equal(JSON.stringify(db.state.audits[0].metadata).includes("forged"), false);
});

test("event admin update route keeps URL slug authoritative and ignores forged actor/provenance body fields", async () => {
  const db = createAdminEventDb({
    events: [{
      slug: "demo-hours",
      title: "Demo Hours",
      description: "Build together.",
      status: "open",
      venue_address: "2020 Eye street",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z"
    }]
  });

  const response = await updateEventRoute({
    request: adminRequest("https://hackthevalley.org/api/events/demo-hours", {
      method: "PATCH",
      body: {
        slug: "attacker-slug",
        title: "Demo Hours Updated",
        status: "closed",
        actorUserId: "usr_attacker",
        actor_user_id: "usr_attacker",
        source: "forged-source",
        admin: true
      }
    }),
    env: { HTV_DB: db },
    params: { slug: "demo-hours" }
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["event", "success"]);
  assert.equal(body.event.slug, "demo-hours");
  assert.equal(body.event.title, "Demo Hours Updated");
  assert.equal(db.state.events.has("attacker-slug"), false);
  assert.equal(db.state.eventWrites[0].args[0], "demo-hours");
  assert.equal(db.state.eventWrites[0].args.includes("usr_attacker"), false);
  assert.equal(db.state.audits[0].args[1], "event.update");
  assert.equal(db.state.audits[0].args[2], "usr_admin");
  assert.equal(db.state.audits[0].metadata.source, "admin");
  assert.equal(db.state.audits[0].metadata.route, "events.slug.patch");
});

test("event admin save keeps an undated planning draft's one stable instance ID through dating and moving", async () => {
  const db = createAdminEventDb({
    events: [{ slug: "demo-hours", title: "Demo Hours", status: "draft", created_at: "2026-06-01T00:00:00.000Z" }]
  });
  db.state.instances.set("event_instance_draft_1", {
    id: "event_instance_draft_1", event_slug: "demo-hours", instance_key: "draft-1", title: "Demo Hours",
    starts_at: null, ends_at: null, status: "draft", metadata_json: JSON.stringify({ planning_draft: true }), created_at: "2026-06-01T00:00:00.000Z"
  });
  const date = async (startsAt) => await updateEventRoute({
    request: adminRequest("https://hackthevalley.org/api/events/demo-hours", { method: "PATCH", body: { starts_at: startsAt, status: "open" } }),
    env: { HTV_DB: db }, params: { slug: "demo-hours" }
  });
  assert.equal((await date("2027-09-10T16:00:00.000Z")).status, 200);
  assert.equal((await date("2027-09-17T16:00:00.000Z")).status, 200);
  assert.equal(db.state.instances.size, 1);
  assert.equal(db.state.instances.get("event_instance_draft_1").starts_at, "2027-09-17T16:00:00.000Z");
  assert.equal(db.state.instanceWrites.filter((write) => /UPDATE event_instances SET/.test(write.sql)).length, 2);
});

test("event admin auth remains a route concern before Events domain writes", async () => {
  const db = createAdminEventDb({ currentUser: null, role: null });
  const response = await createEventRoute({
    request: new Request("https://hackthevalley.org/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Unauthorized Event", status: "open" })
    }),
    env: { HTV_DB: db },
    params: {}
  });

  assert.equal(response.status, 401);
  assert.equal(db.state.eventWrites.length, 0);
  assert.equal(db.state.instanceWrites.length, 0);
  assert.equal(db.state.audits.length, 0);
});

test("Events domain derives trusted admin provenance from route access, not caller input", () => {
  assert.deepEqual(trustedEventAdminProvenance({
    user: { id: "usr_admin" },
    role: { role: "admin", scope_type: "global", scope_id: "*" },
    bootstrap: false
  }), {
    source: "admin",
    actorUserId: "usr_admin",
    role: "admin",
    scopeType: "global",
    scopeId: "*",
    bootstrap: false
  });
  assert.equal(trustedEventAdminProvenance({ bootstrap: true }).source, "bootstrap_admin");
});

test("event image upload intent validation/key construction lives in Events domain", () => {
  const upload = prepareEventImageUploadFromAdminRoute({
    slug: "demo-hours",
    filename: "hero.png",
    contentType: "Image/PNG",
    contentLength: 512,
    maxBytes: 1024,
    id: "img_test",
    now: "2026-06-23T12:00:00.000Z"
  });

  assert.equal(upload.contentType, "image/png");
  assert.equal(upload.key, "event-images/demo-hours/2026-06-23T12-00-00-000Z-img_test-hero.png");
  assert.equal(upload.imageUrl, "/api/events/demo-hours/image?key=event-images%2Fdemo-hours%2F2026-06-23T12-00-00-000Z-img_test-hero.png");
  assert.deepEqual(upload.metadata, {
    originalFilename: "hero.png",
    kind: "event-image",
    eventSlug: "demo-hours",
    uploadedAt: "2026-06-23T12:00:00.000Z"
  });
  assert.throws(() => prepareEventImageUploadFromAdminRoute({ slug: "demo-hours", contentType: "text/plain" }), /image file/);
  assert.throws(() => prepareEventImageUploadFromAdminRoute({ slug: "demo-hours", contentType: "image/png", contentLength: 2, maxBytes: 1 }), /too large/);

  const imageRouteSource = readFileSync(new URL("../functions/api/events/[slug]/image.js", import.meta.url), "utf8");
  assert.match(imageRouteSource, /prepareEventImageUploadFromAdminRoute/);
  assert.match(imageRouteSource, /assertEventImageKeyForRoute/);
  assert.doesNotMatch(imageRouteSource, /function assertImageUpload/);
});

test("event photo upload intent validation/key construction lives in Events domain", () => {
  const upload = prepareEventPhotoUploadFromOrganizerRoute({
    slug: "demo-hours",
    eventInstanceId: "inst_demo_hours_2026_07_22",
    filename: "../photos/demo photo.jpg",
    kind: "photo",
    contentType: "Image/JPEG; charset=binary",
    contentLength: 512,
    maxBytes: 1024,
    id: "pho_test",
    now: "2026-06-23T12:00:00.000Z"
  });

  assert.equal(upload.ok, true);
  assert.equal(upload.contentType, "image/jpeg");
  assert.equal(upload.safeFilename, "demo-photo.jpg");
  assert.equal(upload.key, "event-photos/inst_demo_hours_2026_07_22/pho_test-demo-photo.jpg");
  assert.equal(upload.publicUrl, "/api/events/demo-hours/instances/inst_demo_hours_2026_07_22/photos?key=event-photos%2Finst_demo_hours_2026_07_22%2Fpho_test-demo-photo.jpg");
  assert.deepEqual(upload.metadata, {
    originalFilename: "demo-photo.jpg",
    kind: "photo",
    eventSlug: "demo-hours",
    eventInstanceId: "inst_demo_hours_2026_07_22",
    uploadedAt: "2026-06-23T12:00:00.000Z"
  });

  assert.deepEqual(
    prepareEventPhotoUploadFromOrganizerRoute({ slug: "demo-hours", eventInstanceId: "inst_1", kind: "other", contentType: "image/jpeg" }).errors,
    ["kind must be photo or video"]
  );
  assert.match(
    prepareEventPhotoUploadFromOrganizerRoute({ slug: "demo-hours", eventInstanceId: "inst_1", kind: "video", contentType: "image/jpeg" }).errors.join("; "),
    /video uploads must be mp4/
  );
  assert.match(
    prepareEventPhotoUploadFromOrganizerRoute({ slug: "demo-hours", eventInstanceId: "inst_1", kind: "photo", contentType: "image/jpeg", contentLength: 2, maxBytes: 1 }).errors.join("; "),
    /too large/
  );

  const photoRouteSource = readFileSync(new URL("../functions/api/events/[slug]/instances/[instanceId]/photos/index.js", import.meta.url), "utf8");
  assert.match(photoRouteSource, /prepareEventPhotoUploadFromOrganizerRoute/);
  assert.doesNotMatch(photoRouteSource, /function validateEventPhotoUpload/);
});

test("public event reads and Demo Hours address stay stable while admin writes move behind boundary", async () => {
  const db = createAdminEventDb({
    events: [{ slug: "demo-hours", title: "Demo Hours", status: "open", venue_address: "2020 Eye street" }]
  });
  const { onRequestGet } = await import("../functions/api/events/[slug].js");
  const response = await onRequestGet({
    request: new Request("https://hackthevalley.org/api/events/demo-hours"),
    env: { HTV_DB: db },
    params: { slug: "demo-hours" }
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.event.slug, "demo-hours");
  assert.equal(body.event.venue_address, "2020 Eye street");
});
