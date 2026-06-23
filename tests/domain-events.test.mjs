import test from "node:test";
import assert from "node:assert/strict";

import {
  getEventSeries,
  listEventInstances,
  normalizeEventInstanceInput,
  normalizeEventSeriesInput,
  parseSignupFieldConfig,
  previewGeneratedInstances,
  resolveOpenEventInstance,
  toEventInstance,
  toEventSeries
} from "../functions/_lib/domain/events.js";

const seriesRow = {
  slug: "demo-hours",
  title: "Demo Hours",
  description: "Build together.",
  starts_at: "2026-07-23T01:00:00.000Z",
  ends_at: "2026-07-23T03:00:00.000Z",
  venue_name: "Mesh Cowork",
  venue_address: "2020 Eye street",
  capacity: 40,
  status: "open",
  image_url: "/assets/events/demo-hours.png",
  page_content: "Bring a laptop.",
  signup_fields_json: JSON.stringify({
    role_label: "I want to",
    default_role: "attend",
    roles: [
      { value: "attend", label: "Attend" },
      { value: "Demo Project", label: "Demo project", description: "Share what you built" }
    ]
  }),
  recurrence_rule_json: JSON.stringify({
    frequency: "weekly",
    interval: 1,
    timezone: "America/Los_Angeles",
    day_of_week: "wednesday",
    start_time: "18:00",
    duration_minutes: 120,
    starts_on: "2026-07-22",
    generate_weeks_ahead: 2
  }),
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-02T00:00:00.000Z",
  instance_count: 2,
  active_instance_id: "inst_demo_hours_2026_07_22_1800",
  active_instance_key: "2026-07-22-1800"
};

test("maps EventSeries rows into explicit event series DTOs", () => {
  const series = toEventSeries(seriesRow);

  assert.equal(series.slug, "demo-hours");
  assert.equal(series.kind, "event_series");
  assert.equal(series.signup_fields.roles[1].value, "demo_project");
  assert.equal(series.signup_fields.default_role, "attend");
  assert.equal(series.recurrence_rule.frequency, "weekly");
  assert.equal(series.instance_count, 2);
  assert.equal(series.active_instance_key, "2026-07-22-1800");
  assert.equal(series.signup_fields_json, seriesRow.signup_fields_json);
});

test("maps EventInstance rows into explicit event instance DTOs", () => {
  const instance = toEventInstance({
    id: "inst_demo_hours_2026_07_22_1800",
    event_slug: "demo-hours",
    instance_key: "2026-07-22-1800",
    title: "Demo Hours",
    starts_at: "2026-07-23T01:00:00.000Z",
    ends_at: "2026-07-23T03:00:00.000Z",
    venue_name: "Mesh Cowork",
    venue_address: "2020 Eye street",
    capacity: 40,
    status: "open",
    metadata_json: JSON.stringify({ generated_from_recurrence: true }),
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-02T00:00:00.000Z"
  });

  assert.equal(instance.kind, "event_instance");
  assert.equal(instance.event_slug, "demo-hours");
  assert.deepEqual(instance.metadata, { generated_from_recurrence: true });
});

test("parses signup role config with normalized values and useful validation errors", () => {
  const config = parseSignupFieldConfig(seriesRow);
  assert.deepEqual(config.roles.map((role) => role.value), ["attend", "demo_project"]);
  assert.equal(config.label, "I want to");

  assert.throws(
    () => parseSignupFieldConfig({ signup_fields_json: "{not-json" }),
    /signup_fields_json must be valid JSON/
  );
  assert.throws(
    () => parseSignupFieldConfig({ signup_fields_json: JSON.stringify({ roles: "attend" }) }),
    /Validation failed/
  );
});

test("rejects malformed recurrence JSON at mapper boundaries", () => {
  assert.throws(
    () => toEventSeries({ ...seriesRow, recurrence_rule_json: "[]" }),
    /recurrence_rule_json must be a JSON object/
  );
  assert.throws(
    () => toEventSeries({ ...seriesRow, recurrence_rule_json: JSON.stringify({ interval: 0 }) }),
    /Validation failed/
  );
});

test("normalizes event series and instance write inputs without changing storage field names", () => {
  const series = normalizeEventSeriesInput({ title: " Demo Hours ", status: "OPEN", capacity: "50" });
  assert.deepEqual(series.errors, []);
  assert.equal(series.event.slug, "demo-hours");
  assert.equal(series.event.status, "open");
  assert.equal(series.event.capacity, 50);

  const instance = normalizeEventInstanceInput({ status: "open", capacity: "" }, series.event);
  assert.deepEqual(instance.errors, []);
  assert.equal(instance.instance.event_slug, "demo-hours");
  assert.equal(instance.instance.title, "Demo Hours");
  assert.equal(instance.instance.capacity, 50);
});

test("event series write input rejects non-object signup and recurrence JSON", () => {
  const badSignup = normalizeEventSeriesInput({ title: "Broken", signup_fields_json: "[]" });
  assert.match(badSignup.errors.join("; "), /signup_fields_json must be a JSON object/);

  const badRecurrence = normalizeEventSeriesInput({ title: "Broken", recurrence_rule_json: JSON.stringify({ interval: 0 }) });
  assert.match(badRecurrence.errors.join("; "), /recurrence_rule_json\.interval/);
});

test("event series and instance query helpers map D1 rows", async () => {
  const sqls = [];
  const db = {
    prepare(sql) {
      sqls.push(sql);
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM events/.test(sql)) return seriesRow;
          if (/FROM event_instances/.test(sql)) return { id: "inst_demo_hours_2026_07_22_1800", event_slug: this.args[0], instance_key: "2026-07-22-1800", status: "open" };
          return null;
        },
        async all() {
          return { results: [{ id: "inst_demo_hours_2026_07_22_1800", event_slug: this.args[0], instance_key: "2026-07-22-1800", status: "open" }] };
        }
      };
    }
  };

  const series = await getEventSeries(db, "demo-hours");
  const instances = await listEventInstances(db, "demo-hours");
  const open = await resolveOpenEventInstance(db, "demo-hours");

  assert.equal(series.slug, "demo-hours");
  assert.equal(instances[0].kind, "event_instance");
  assert.equal(open.id, "inst_demo_hours_2026_07_22_1800");
  assert.match(sqls.join("\n"), /FROM events/);
  assert.match(sqls.join("\n"), /instance_count/);
  assert.match(sqls.join("\n"), /active_instance_id/);
  assert.match(sqls.join("\n"), /FROM event_instances/);
});

test("recurrence preview is deterministic and dry-run only", () => {
  const first = previewGeneratedInstances(seriesRow, { now: "2026-07-20T12:00:00.000Z" });
  const second = previewGeneratedInstances(seriesRow, { now: "2026-07-20T12:00:00.000Z" });

  assert.deepEqual(second.instances, first.instances);
  assert.equal(first.instances.length, 2);
  assert.equal(first.instances[0].instance_key, "2026-07-22-1800");
  assert.equal(first.instances[0].id, "inst_demo_hours_2026_07_22_1800");
  assert.equal(first.applied, false);
});
