import assert from "node:assert/strict";
import test from "node:test";
import {
  createDraftEventInstance,
  previewAnchorShift,
  updateEventInstanceById
} from "../functions/_lib/domain/event-planning.js";

function draftDb() {
  const state = { rows: new Map(), event: { slug: "hack-the-valley", title: "Hack the Valley" } };
  return {
    state,
    prepare(sql) {
      return {
        args: [], bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM events WHERE slug/.test(sql)) return state.event;
          if (/FROM event_instances WHERE id/.test(sql)) return state.rows.get(this.args[0]) || null;
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async run() {
          if (/INSERT INTO event_instances/.test(sql)) {
            const [id, eventSlug, instanceKey, title, , , venueName, venueAddress, capacity, , metadata, createdAt, updatedAt] = this.args;
            state.rows.set(id, { id, event_slug: eventSlug, instance_key: instanceKey, title, starts_at: null, ends_at: null, venue_name: venueName, venue_address: venueAddress, capacity, status: "draft", metadata_json: metadata, created_at: createdAt, updated_at: updatedAt });
            return { success: true };
          }
          if (/UPDATE event_instances SET/.test(sql)) {
            const [title, startsAt, endsAt, venueName, venueAddress, capacity, status, updatedAt, id] = this.args;
            state.rows.set(id, { ...state.rows.get(id), title, starts_at: startsAt, ends_at: endsAt, venue_name: venueName, venue_address: venueAddress, capacity, status, updated_at: updatedAt });
            return { success: true };
          }
          if (/UPDATE event_plan_anchors SET/.test(sql)) return { success: true };
          throw new Error(`Unexpected run query: ${sql}`);
        },
        async all() { return { results: [] }; }
      };
    }
  };
}

test("draft event instances retain their ID and row count through date changes", async () => {
  const db = draftDb();
  const draft = await createDraftEventInstance(db, { event_slug: "hack-the-valley", title: "HTV 2027" }, { userId: "usr_admin" }, { now: "2026-07-12T00:00:00.000Z" });
  const dated = await updateEventInstanceById(db, draft.id, { starts_at: "2027-09-10T16:00:00.000Z" }, { userId: "usr_admin" });
  const moved = await updateEventInstanceById(db, draft.id, { starts_at: "2027-09-17T16:00:00.000Z" }, { userId: "usr_admin" });
  assert.equal(dated.id, draft.id);
  assert.equal(moved.id, draft.id);
  assert.equal(db.state.rows.size, 1);
  assert.equal(moved.starts_at, "2027-09-17T16:00:00.000Z");
});

test("anchor shift preview moves only open relative non-overridden work", async () => {
  const db = {
    prepare(sql) {
      return {
        args: [], bind(...args) { this.args = args; return this; },
        async first() { return /FROM event_plans p/.test(sql) ? { id: "plan_1", event_instance_id: "instance_1" } : null; },
        async all() {
          if (/FROM event_plan_items/.test(sql)) return { results: [
            { id: "move", title: "Move me", anchor_key: "applications_open", status: "open", schedule_mode: "relative", due_at: "2027-09-03T16:00:00.000Z", manual_override_at: null },
            { id: "done", title: "Done", anchor_key: "applications_open", status: "completed", schedule_mode: "relative", due_at: "2027-09-03T16:00:00.000Z", manual_override_at: null },
            { id: "blocked", title: "Blocked", anchor_key: "applications_open", status: "blocked", schedule_mode: "relative", due_at: "2027-09-03T16:00:00.000Z", manual_override_at: null },
            { id: "fixed", title: "Fixed", anchor_key: "applications_open", status: "open", schedule_mode: "fixed", due_at: "2027-09-03T16:00:00.000Z", manual_override_at: null },
            { id: "manual", title: "Manual", anchor_key: "applications_open", status: "open", schedule_mode: "relative", due_at: "2027-09-03T16:00:00.000Z", manual_override_at: "2027-01-01T00:00:00.000Z" }
          ] };
          if (/FROM event_plan_anchors WHERE/.test(sql)) return { results: [{ anchor_key: "applications_open", occurs_at: "2027-09-10T16:00:00.000Z", source: "manual" }] };
          return { results: [] };
        }
      };
    }
  };
  const preview = await previewAnchorShift(db, "plan_1", { anchor_key: "applications_open", occurs_at: "2027-09-17T16:00:00.500Z" });
  assert.deepEqual(preview.items.map(({ itemId, moved, reason }) => ({ itemId, moved, reason })), [
    { itemId: "move", moved: true, reason: null },
    { itemId: "done", moved: false, reason: "completed" },
    { itemId: "blocked", moved: true, reason: null },
    { itemId: "fixed", moved: false, reason: "fixed" },
    { itemId: "manual", moved: false, reason: "manual_override" }
  ]);
  assert.equal(preview.items[0].after, "2027-09-10T16:00:00.500Z");
});
