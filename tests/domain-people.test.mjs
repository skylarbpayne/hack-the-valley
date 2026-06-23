import assert from "node:assert/strict";
import test from "node:test";

import {
  applySafetyProfileToMetadata,
  normalizePersonSafetyProfile,
  personSafetyReadiness,
  safetyProfileFromPerson,
  safetyProfileInputFromPatch,
  snapshotPersonSafetyForEvent,
  updatePersonSafetyProfile
} from "../functions/_lib/domain/people.js";
import {
  normalizeParticipationInput,
  registerParticipation,
  resolveParticipationReadiness
} from "../functions/_lib/domain/participation.js";

function createPeopleDb() {
  const db = {
    users: new Map(),
    signups: new Map(),
    contacts: new Map(),
    participantEvents: new Map(),
    statements: [],
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: async () => first(db, sql, params),
          all: async () => all(db, sql, params),
          run: async () => run(db, sql, params)
        })
      };
    }
  };
  return db;
}

function first(db, sql, params) {
  db.statements.push({ op: "first", sql, params });
  if (/SELECT \* FROM users WHERE id = \?/.test(sql)) {
    return db.users.get(params[0]) || null;
  }
  if (/FROM signups\s+WHERE event_slug = \? AND event_instance_id = \? AND user_id = \?/.test(sql)) {
    const [, eventInstanceId, userId] = params;
    return [...db.signups.values()].find((row) => row.event_instance_id === eventInstanceId && row.user_id === userId) || null;
  }
  if (/FROM emergency_contacts\s+WHERE event_instance_id = \? AND user_id = \?/.test(sql)) {
    return db.contacts.get(`${params[0]}:${params[1]}`) || null;
  }
  return null;
}

function all(db, sql, params) {
  db.statements.push({ op: "all", sql, params });
  if (/FROM event_participant_events/.test(sql)) {
    const [eventInstanceId, userId] = params;
    return { results: [...db.participantEvents.values()].filter((row) => row.event_instance_id === eventInstanceId && row.user_id === userId) };
  }
  return { results: [] };
}

function run(db, sql, params) {
  db.statements.push({ op: "run", sql, params });
  if (/UPDATE users\s+SET metadata_json = \?/.test(sql)) {
    const [metadataJson, updatedAt, userId] = params;
    const existing = db.users.get(userId);
    db.users.set(userId, { ...existing, metadata_json: metadataJson, updated_at: updatedAt });
    return { success: true };
  }
  if (/INSERT INTO users/.test(sql)) {
    const [id, email, name, firstName, lastName, phone, school, metadataJson, createdAt, updatedAt] = params;
    db.users.set(id, { id, email, name, first_name: firstName, last_name: lastName, phone, school, metadata_json: metadataJson, created_at: createdAt, updated_at: updatedAt });
    return { success: true };
  }
  if (/INSERT INTO signups/.test(sql)) {
    const [id, eventSlug, eventInstanceId, userId, name, firstName, lastName, phone, school, year, experience, notes, emailListOptIn, metadataJson, mailingStatus, mailingDetail, createdAt, updatedAt] = params;
    const key = `${eventInstanceId}:${userId}`;
    const existing = db.signups.get(key) || {};
    db.signups.set(key, { ...existing, id: existing.id || id, event_slug: eventSlug, event_instance_id: eventInstanceId, user_id: userId, name, first_name: firstName, last_name: lastName, phone, school, year, experience, notes, email_list_opt_in: emailListOptIn, metadata_json: metadataJson, mailing_list_status: mailingStatus, mailing_list_detail: mailingDetail, created_at: existing.created_at || createdAt, updated_at: updatedAt });
    return { success: true };
  }
  if (/INSERT INTO emergency_contacts/.test(sql)) {
    const [id, eventInstanceId, userId, signupId, name, relationship, phone, source, createdAt, updatedAt] = params;
    const key = `${eventInstanceId}:${userId}`;
    const existing = db.contacts.get(key) || {};
    db.contacts.set(key, { ...existing, id: existing.id || id, event_instance_id: eventInstanceId, user_id: userId, signup_id: signupId || existing.signup_id || null, name, relationship, phone, source, created_at: existing.created_at || createdAt, updated_at: updatedAt });
    return { success: true };
  }
  if (/INSERT OR IGNORE INTO event_participant_events/.test(sql)) {
    const [id, eventSlug, eventInstanceId, userId, signupId, eventType, actorUserId, source, dataJson, occurredAt, createdAt] = params;
    if (!db.participantEvents.has(id)) db.participantEvents.set(id, { id, event_slug: eventSlug, event_instance_id: eventInstanceId, user_id: userId, signup_id: signupId, event_type: eventType, actor_user_id: actorUserId, source, data_json: dataJson, occurred_at: occurredAt, created_at: createdAt });
    return { success: true };
  }
  return { success: true };
}

test("people safety profile normalizes reusable safety contact and readiness", () => {
  const normalized = normalizePersonSafetyProfile({
    emergency_contact_name: "Ada Helper",
    emergency_contact_phone: "661-555-0100",
    emergency_contact_relationship: "Parent"
  });

  assert.equal(normalized.complete, true);
  assert.equal(normalized.readiness.ready, true);
  assert.deepEqual(normalized.profile.emergency_contact, {
    name: "Ada Helper",
    phone: "661-555-0100",
    relationship: "Parent"
  });

  const missing = normalizePersonSafetyProfile({ emergency_contact_name: "Ada Helper" });
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.readiness.missing_safety_fields, ["emergency_contact_phone"]);
});

test("people safety profile reads from users.metadata_json.safety_profile without a schema migration", () => {
  const person = {
    id: "usr_ada",
    email: "ada@example.com",
    metadata_json: JSON.stringify({
      pronouns: "she/her",
      safety_profile: {
        emergency_contact: { name: "Ada Helper", phone: "661-555-0100", relationship: "Parent" },
        updated_at: "2026-06-23T18:00:00.000Z"
      }
    })
  };

  const profile = safetyProfileFromPerson(person);
  assert.equal(profile.complete, true);
  assert.equal(personSafetyReadiness(person).ready, true);
  assert.equal(profile.contact.name, "Ada Helper");
});

test("updatePersonSafetyProfile preserves existing metadata while writing reusable safety profile", async () => {
  const db = createPeopleDb();
  db.users.set("usr_ada", {
    id: "usr_ada",
    email: "ada@example.com",
    metadata_json: JSON.stringify({ pronouns: "she/her", interests: ["ai"] }),
    updated_at: "old"
  });

  const updated = await updatePersonSafetyProfile(db, {
    personId: "usr_ada",
    safetyInput: { name: "Ada Helper", phone: "661-555-0100", relationship: "Parent" },
    now: "2026-06-23T18:00:00.000Z"
  });

  const metadata = JSON.parse(updated.metadata_json);
  assert.equal(metadata.pronouns, "she/her");
  assert.deepEqual(metadata.interests, ["ai"]);
  assert.deepEqual(metadata.safety_profile.emergency_contact, {
    name: "Ada Helper",
    phone: "661-555-0100",
    relationship: "Parent"
  });
});

test("snapshotPersonSafetyForEvent writes event-specific emergency contact snapshot", async () => {
  const db = createPeopleDb();
  await snapshotPersonSafetyForEvent(db, {
    personId: "usr_ada",
    eventInstanceId: "inst_demo_hours_20260722",
    signupId: "sgn_ada",
    safetyProfile: { name: "Ada Helper", phone: "661-555-0100", relationship: "Parent" },
    source: "person_safety_profile",
    now: "2026-06-23T18:00:00.000Z"
  });

  const snapshot = db.contacts.get("inst_demo_hours_20260722:usr_ada");
  assert.equal(snapshot.name, "Ada Helper");
  assert.equal(snapshot.signup_id, "sgn_ada");
  assert.equal(snapshot.source, "person_safety_profile");
});

test("signed-in participation can use reusable safety profile and still snapshots day-of contact", async () => {
  const db = createPeopleDb();
  db.users.set("usr_ada", {
    id: "usr_ada",
    email: "ada@example.com",
    name: "Ada Lovelace",
    first_name: "Ada",
    last_name: "Lovelace",
    metadata_json: JSON.stringify({
      safety_profile: {
        emergency_contact: { name: "Ada Helper", phone: "661-555-0100", relationship: "Parent" },
        updated_at: "2026-06-23T18:00:00.000Z"
      }
    })
  });

  const normalized = normalizeParticipationInput({ signup_role: "attend" }, {
    slug: "demo-hours",
    signup_fields: { roles: [{ value: "attend", label: "Attend" }] }
  }, db.users.get("usr_ada"));

  assert.equal(normalized.readiness.ready, true);
  assert.deepEqual(normalized.safetyInput, { name: "Ada Helper", phone: "661-555-0100", relationship: "Parent" });

  const registration = await registerParticipation(db, {
    person: db.users.get("usr_ada"),
    eventSeries: { slug: "demo-hours" },
    eventInstance: { id: "inst_demo_hours_20260722" },
    eventRole: "attend",
    signup: normalized.signup,
    safetyInput: normalized.safetyInput,
    source: "signed-in-event-signup",
    now: "2026-06-23T18:10:00.000Z"
  });

  assert.equal(registration.readiness.ready, true);
  const snapshot = db.contacts.get("inst_demo_hours_20260722:usr_ada");
  assert.equal(snapshot.name, "Ada Helper");
  assert.equal(snapshot.source, "signup");
});

test("resolveParticipationReadiness falls back to reusable profile when event snapshot is missing", async () => {
  const db = createPeopleDb();
  db.users.set("usr_ada", {
    id: "usr_ada",
    email: "ada@example.com",
    metadata_json: JSON.stringify({
      safety_profile: {
        emergency_contact: { name: "Ada Helper", phone: "661-555-0100", relationship: "Parent" }
      }
    })
  });

  const readiness = await resolveParticipationReadiness(db, {
    personId: "usr_ada",
    eventInstanceId: "inst_demo_hours_20260722"
  });

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.missing_safety_fields, []);
});

test("event-scoped emergency contact patch is not promoted into reusable safety profile", () => {
  const profileInput = safetyProfileInputFromPatch({
    emergency_contacts: [{
      event_instance_id: "inst_someone_else",
      name: "Nope",
      phone: "661-555-0199"
    }]
  });

  assert.equal(profileInput, null);
});

test("applySafetyProfileToMetadata rejects incomplete updates without clobbering metadata", () => {
  const applied = applySafetyProfileToMetadata(JSON.stringify({ pronouns: "they/them" }), {
    name: "Helper"
  }, { now: "2026-06-23T18:00:00.000Z" });

  assert.equal(applied.changed, false);
  assert.equal(applied.safety.complete, false);
  assert.equal(applied.metadata.pronouns, "they/them");
}
);