import test from "node:test";
import assert from "node:assert/strict";

import {
  appendAuditEvent,
  buildAuditEvent,
  toAuditEvent
} from "../functions/_lib/domain/audit.js";

function createRecordingDb({ failGenericAuditEvents = false } = {}) {
  const calls = [];
  return {
    calls,
    db: {
      prepare(sql) {
        calls.push({ sql });
        return {
          bind(...binds) {
            calls[calls.length - 1].binds = binds;
            return {
              async run() {
                if (failGenericAuditEvents && /INSERT INTO audit_events/.test(sql)) {
                  throw new Error("no such table: audit_events");
                }
                calls[calls.length - 1].ran = true;
                return { success: true };
              }
            };
          }
        };
      }
    }
  };
}

test("toAuditEvent maps legacy admin_audit_events rows into the generic audit event shape", () => {
  const event = toAuditEvent({
    id: "audit_legacy",
    action: "grant_admin",
    actor_user_id: "user_admin",
    target_user_id: "user_target",
    target_email: "target@example.com",
    role: "admin",
    scope_type: "global",
    scope_id: "*",
    metadata_json: '{"source":"admin-role-manager"}',
    created_at: "2026-06-23T12:00:00.000Z"
  });

  assert.deepEqual(event, {
    id: "audit_legacy",
    action: "grant_admin",
    actorUserId: "user_admin",
    targetType: "user",
    targetId: "user_target",
    approvalId: null,
    targetEmail: "target@example.com",
    role: "admin",
    scopeType: "global",
    scopeId: "*",
    metadata: { source: "admin-role-manager" },
    createdAt: "2026-06-23T12:00:00.000Z"
  });
});

test("toAuditEvent maps generic audit_events rows without role-shaped columns", () => {
  const event = toAuditEvent({
    id: "audit_generic_row",
    action: "badge.revoke",
    actor_user_id: "user_admin",
    target_type: "badge_award",
    target_id: "award_1",
    scope_type: "badge_award",
    scope_id: "award_1",
    metadata_json: JSON.stringify({ reason: "mistaken award", targetEmail: "winner@example.com" }),
    created_at: "2026-06-23T12:00:00.000Z"
  });

  assert.equal(event.targetType, "badge_award");
  assert.equal(event.targetId, "award_1");
  assert.equal(event.targetEmail, "winner@example.com");
  assert.deepEqual(event.metadata, { reason: "mistaken award", targetEmail: "winner@example.com" });
});

test("toAuditEvent reads generic target metadata encoded in metadata_json for V0 compatibility", () => {
  const event = toAuditEvent({
    id: "audit_generic",
    action: "event_instance.publish",
    actor_user_id: "user_admin",
    target_user_id: null,
    target_email: null,
    role: null,
    scope_type: "event_instance",
    scope_id: "instance_1",
    metadata_json: JSON.stringify({
      targetType: "event_instance",
      targetId: "instance_1",
      approvalId: "approval_1",
      note: "kept in metadata"
    }),
    created_at: "2026-06-23T12:00:00.000Z"
  });

  assert.equal(event.targetType, "event_instance");
  assert.equal(event.targetId, "instance_1");
  assert.equal(event.approvalId, "approval_1");
  assert.deepEqual(event.metadata, {
    targetType: "event_instance",
    targetId: "instance_1",
    approvalId: "approval_1",
    note: "kept in metadata"
  });
});

test("toAuditEvent ignores partial metadata targets instead of mixing them with legacy user targets", () => {
  const event = toAuditEvent({
    id: "audit_partial_target",
    action: "grant_admin",
    actor_user_id: "user_admin",
    target_user_id: "user_target",
    target_email: " ",
    role: " ",
    scope_type: " ",
    scope_id: " ",
    metadata_json: JSON.stringify({
      targetType: "event_instance",
      targetEmail: "target@example.com",
      role: "admin",
      scopeType: "global",
      scopeId: "*"
    }),
    created_at: "2026-06-23T12:00:00.000Z"
  });

  assert.equal(event.targetType, "user");
  assert.equal(event.targetId, "user_target");
  assert.equal(event.targetEmail, "target@example.com");
  assert.equal(event.role, "admin");
  assert.equal(event.scopeType, "global");
  assert.equal(event.scopeId, "*");
});

test("buildAuditEvent creates generic events without requiring schema changes", () => {
  const event = buildAuditEvent({
    action: "badge.award",
    actorUserId: "user_admin",
    targetType: "badge_award",
    targetId: "award_1",
    approvalId: "approval_1",
    metadata: { badgeId: "badge_1" }
  });

  assert.match(event.id, /^audit_[a-f0-9]{32}$/);
  assert.equal(event.action, "badge.award");
  assert.equal(event.actorUserId, "user_admin");
  assert.equal(event.targetType, "badge_award");
  assert.equal(event.targetId, "award_1");
  assert.equal(event.approvalId, "approval_1");
  assert.deepEqual(event.metadata, { badgeId: "badge_1" });
  assert.match(event.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("buildAuditEvent preserves explicit scope separate from target", async () => {
  const event = buildAuditEvent({
    action: "grant_admin",
    actorUserId: "usr_admin",
    targetType: "user",
    targetId: "usr_target",
    scopeType: "global",
    scopeId: "*",
    metadata: { source: "admin-role-manager", role: "admin", targetEmail: "target@example.com" },
    createdAt: "2026-06-23T12:00:00.000Z"
  });

  assert.equal(event.targetType, "user");
  assert.equal(event.targetId, "usr_target");
  assert.equal(event.scopeType, "global");
  assert.equal(event.scopeId, "*");
  assert.equal(event.createdAt, "2026-06-23T12:00:00.000Z");

  const { db, calls } = createRecordingDb();
  const result = await appendAuditEvent(db, event);

  assert.equal(result.scopeType, "global");
  assert.equal(result.scopeId, "*");
  assert.deepEqual(calls.find((call) => /INSERT INTO audit_events/.test(call.sql)).binds.slice(5, 7), ["global", "*"]);
});

test("buildAuditEvent generates unique ids for repeated identical events in the same millisecond", () => {
  const OriginalDate = globalThis.Date;
  const fixedNow = "2026-06-23T12:00:00.000Z";
  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }
  }
  FixedDate.now = () => new OriginalDate(fixedNow).getTime();
  FixedDate.parse = OriginalDate.parse;
  FixedDate.UTC = OriginalDate.UTC;

  globalThis.Date = FixedDate;
  try {
    const ids = new Set(Array.from({ length: 500 }, () => buildAuditEvent({
      action: "badge.award",
      actorUserId: "user_admin",
      targetType: "badge_award",
      targetId: "award_1",
      approvalId: "approval_1",
      metadata: { badgeId: "badge_1" }
    }).id));

    assert.equal(ids.size, 500);
  } finally {
    globalThis.Date = OriginalDate;
  }
});

test("appendAuditEvent writes generic audit_events rows and keeps storage metadata self-describing", async () => {
  const event = {
    id: "audit_test",
    action: "badge.award",
    actorUserId: "user_admin",
    targetType: "badge_award",
    targetId: "award_1",
    approvalId: "approval_1",
    metadata: { badgeId: "badge_1", targetEmail: "winner@example.com", role: "winner" },
    createdAt: "2026-06-23T12:00:00.000Z"
  };
  const { db, calls } = createRecordingDb();

  const result = await appendAuditEvent(db, event);

  assert.notEqual(result, event);
  assert.deepEqual(result, {
    id: "audit_test",
    action: "badge.award",
    actorUserId: "user_admin",
    targetType: "badge_award",
    targetId: "award_1",
    approvalId: "approval_1",
    metadata: {
      badgeId: "badge_1",
      targetEmail: "winner@example.com",
      role: "winner",
      targetType: "badge_award",
      targetId: "award_1",
      approvalId: "approval_1"
    },
    scopeType: "badge_award",
    scopeId: "award_1",
    createdAt: "2026-06-23T12:00:00.000Z"
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO audit_events/);
  assert.deepEqual(calls[0].binds.slice(0, 7), [
    "audit_test",
    "badge.award",
    "user_admin",
    "badge_award",
    "award_1",
    "badge_award",
    "award_1"
  ]);
  assert.deepEqual(JSON.parse(calls[0].binds[7]), {
    badgeId: "badge_1",
    targetEmail: "winner@example.com",
    role: "winner",
    targetType: "badge_award",
    targetId: "award_1",
    approvalId: "approval_1"
  });
  assert.equal(calls[0].binds[8], "2026-06-23T12:00:00.000Z");
  assert.equal(calls[0].ran, true);
});

test("appendAuditEvent falls back to legacy admin_audit_events before the generic migration is applied", async () => {
  const { db, calls } = createRecordingDb({ failGenericAuditEvents: true });

  await appendAuditEvent(db, {
    id: "audit_fallback",
    action: "grant_admin",
    actorUserId: "user_admin",
    targetType: "user",
    targetId: "user_target",
    scopeType: "global",
    scopeId: "*",
    metadata: { source: "admin-role-manager", targetEmail: "target@example.com", role: "admin" },
    createdAt: "2026-06-23T12:00:00.000Z"
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /INSERT INTO audit_events/);
  assert.match(calls[1].sql, /INSERT INTO admin_audit_events/);
  assert.deepEqual(calls[1].binds.slice(0, 8), [
    "audit_fallback",
    "grant_admin",
    "user_admin",
    "user_target",
    "target@example.com",
    "admin",
    "global",
    "*"
  ]);
  assert.deepEqual(JSON.parse(calls[1].binds[8]), {
    source: "admin-role-manager",
    targetEmail: "target@example.com",
    role: "admin",
    targetType: "user",
    targetId: "user_target"
  });
  assert.equal(calls[1].binds[9], "2026-06-23T12:00:00.000Z");
  assert.equal(calls[1].ran, true);
});

test("appendAuditEvent returns the normalized inserted event with generated durability fields", async () => {
  const { db, calls } = createRecordingDb();

  const result = await appendAuditEvent(db, {
    action: "badge.award",
    actorUserId: "user_admin",
    targetType: "badge_award",
    targetId: "award_1",
    metadata: { badgeId: "badge_1" }
  });

  assert.match(result.id, /^audit_[a-f0-9]{32}$/);
  assert.match(result.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls[0].binds[0], result.id);
  assert.equal(calls[0].binds[8], result.createdAt);
  assert.deepEqual(result.metadata, {
    badgeId: "badge_1",
    targetType: "badge_award",
    targetId: "award_1"
  });
});
