import test from "node:test";
import assert from "node:assert/strict";

import {
  cancelParticipation,
  checkInParticipant,
  listParticipationRoster,
  normalizeParticipationInput,
  registerParticipation,
  resolveParticipationReadiness
} from "../functions/_lib/domain/participation.js";

const demoEvent = {
  kind: "event_series",
  slug: "demo-hours",
  title: "Demo Hours",
  signup_fields_json: JSON.stringify({
    role_label: "I want to",
    default_role: "attend",
    roles: [
      { value: "attend", label: "Attend" },
      { value: "demo", label: "Demo something" }
    ]
  })
};

function createParticipationDb() {
  const statements = [];
  const usersByEmail = new Map();
  const usersById = new Map();
  const signups = [];
  const emergencyContacts = [];
  const participantEvents = [];
  let userSeq = 0;

  function currentState(eventInstanceId, userId) {
    const events = participantEvents.filter((event) => event.event_instance_id === eventInstanceId && event.user_id === userId);
    return {
      signed_up_at: events.filter((event) => event.event_type === "signed_up").map((event) => event.occurred_at).sort()[0] || null,
      checked_in_at: events.filter((event) => event.event_type === "checked_in").map((event) => event.occurred_at).sort().at(-1) || null,
      checked_out_at: events.filter((event) => event.event_type === "checked_out").map((event) => event.occurred_at).sort().at(-1) || null,
      cancelled_at: events.filter((event) => event.event_type === "cancelled").map((event) => event.occurred_at).sort().at(-1) || null
    };
  }

  const db = {
    statements,
    usersByEmail,
    usersById,
    signups,
    emergencyContacts,
    participantEvents,
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
          if (/INSERT INTO users/.test(sql)) {
            const [requestedId, email, name, firstName, lastName, phone, school, metadata, createdAt, updatedAt] = this.args;
            const existing = usersByEmail.get(email);
            const user = existing || { id: requestedId || `usr_${++userSeq}`, email, created_at: createdAt };
            Object.assign(user, {
              name: name || user.name || null,
              first_name: firstName || user.first_name || null,
              last_name: lastName || user.last_name || null,
              phone: phone || user.phone || null,
              school: school || user.school || null,
              metadata_json: metadata || user.metadata_json || null,
              updated_at: updatedAt
            });
            usersByEmail.set(email, user);
            usersById.set(user.id, user);
            return { success: true };
          }
          if (/INSERT INTO signups/.test(sql)) {
            const [id, eventSlug, eventInstanceId, userId, name, firstName, lastName, phone, school, year, experience, notes, emailListOptIn, metadataJson, mailingStatus, mailingDetail, createdAt, updatedAt] = this.args;
            let signup = signups.find((row) => row.event_instance_id === eventInstanceId && row.user_id === userId);
            if (!signup) {
              signup = { id, event_slug: eventSlug, event_instance_id: eventInstanceId, user_id: userId, created_at: createdAt };
              signups.push(signup);
            }
            Object.assign(signup, { name, first_name: firstName, last_name: lastName, phone, school, year, experience, notes, email_list_opt_in: emailListOptIn, metadata_json: metadataJson, mailing_list_status: mailingStatus, mailing_list_detail: mailingDetail, updated_at: updatedAt });
            return { success: true };
          }
          if (/INSERT INTO emergency_contacts/.test(sql)) {
            const [id, eventInstanceId, userId, signupId, name, relationship, phone, source, createdAt, updatedAt] = this.args;
            let contact = emergencyContacts.find((row) => row.event_instance_id === eventInstanceId && row.user_id === userId);
            if (!contact) {
              contact = { id, event_instance_id: eventInstanceId, user_id: userId, created_at: createdAt };
              emergencyContacts.push(contact);
            }
            Object.assign(contact, { signup_id: signupId, name, relationship, phone, source, updated_at: updatedAt });
            return { success: true };
          }
          if (/INSERT OR IGNORE INTO event_participant_events/.test(sql)) {
            const [id, eventSlug, eventInstanceId, userId, signupId, eventTypeOrActor, maybeActorOrSource, maybeSourceOrData, maybeDataOrOccurredAt, maybeOccurredAtOrCreatedAt, maybeCreatedAt] = this.args;
            if (!participantEvents.some((event) => event.id === id)) {
              const explicitType = /'checked_in'/.test(sql) ? "checked_in" : /'signed_up'/.test(sql) ? "signed_up" : null;
              const eventType = explicitType || eventTypeOrActor;
              const actor = explicitType ? eventTypeOrActor : maybeActorOrSource;
              const source = explicitType ? maybeActorOrSource : maybeSourceOrData;
              const dataJson = explicitType ? maybeSourceOrData : maybeDataOrOccurredAt;
              const occurredAt = explicitType ? maybeDataOrOccurredAt : maybeOccurredAtOrCreatedAt;
              const createdAt = explicitType ? maybeOccurredAtOrCreatedAt : maybeCreatedAt;
              participantEvents.push({ id, event_slug: eventSlug, event_instance_id: eventInstanceId, user_id: userId, signup_id: signupId, event_type: eventType, actor, source, data_json: dataJson, occurred_at: occurredAt, created_at: createdAt });
            }
            return { success: true };
          }
          throw new Error(`Unexpected run() query: ${sql}`);
        },
        async first() {
          if (/SELECT \* FROM users WHERE email/.test(sql)) return usersByEmail.get(this.args[0]) || null;
          if (/SELECT \* FROM users WHERE id/.test(sql)) return usersById.get(this.args[0]) || null;
          if (/FROM emergency_contacts/.test(sql)) {
            const [eventInstanceId, userId] = this.args;
            return emergencyContacts.find((row) => row.event_instance_id === eventInstanceId && row.user_id === userId) || null;
          }
          if (/FROM signups s\s+JOIN users u/.test(sql)) {
            const args = this.args;
            const eventInstanceId = args.length === 3 ? args[1] : args[0];
            const userId = args.at(-1);
            const signup = signups.find((row) => row.event_instance_id === eventInstanceId && row.user_id === userId);
            if (!signup) return null;
            const user = usersById.get(userId) || {};
            return { ...signup, ...currentState(eventInstanceId, userId), email: user.email, signup_role: JSON.parse(signup.metadata_json || "{}").signup_role || null };
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          if (/FROM signups s\s+JOIN users u/.test(sql)) {
            const [eventSlug, eventInstanceId] = this.args;
            return {
              results: signups
                .filter((row) => row.event_slug === eventSlug && (!eventInstanceId || row.event_instance_id === eventInstanceId))
                .map((signup) => {
                  const user = usersById.get(signup.user_id) || {};
                  const contact = emergencyContacts.find((row) => row.event_instance_id === signup.event_instance_id && row.user_id === signup.user_id);
                  const state = currentState(signup.event_instance_id, signup.user_id);
                  return {
                    user_id: signup.user_id,
                    signup_id: signup.id,
                    event_instance_id: signup.event_instance_id,
                    signup_role: JSON.parse(signup.metadata_json || "{}").signup_role || null,
                    name: signup.name || user.name,
                    email: user.email,
                    is_signed_up: 1,
                    signed_up_at: state.signed_up_at || signup.created_at,
                    checked_in_at: state.checked_in_at,
                    emergency_contact_name: contact?.name || null,
                    emergency_contact_relationship: contact?.relationship || null,
                    emergency_contact_phone: contact?.phone || null,
                    emergency_contact_updated_at: contact?.updated_at || null,
                    emergency_contact_present: contact?.name && contact?.phone ? 1 : 0,
                    attendance_count: participantEvents.filter((event) => event.user_id === signup.user_id && event.event_type === "checked_in").length,
                    prior_attendance_count: 0
                  };
                })
            };
          }
          throw new Error(`Unexpected all() query: ${sql}`);
        }
      };
      return statement;
    }
  };
  return db;
}

test("normalizeParticipationInput keeps event-specific role choices and anonymous safety validation", () => {
  const missing = normalizeParticipationInput({ name: "Ada", email: "ada@example.com", signup_role: "demo" }, demoEvent, null);
  assert.equal(missing.eventRole, "demo");
  assert.match(missing.errors.join("; "), /emergency contact name is required/);
  assert.match(missing.errors.join("; "), /emergency contact phone is required/);

  const invalidRole = normalizeParticipationInput({ name: "Ada", email: "ada@example.com", signup_role: "judge" }, demoEvent, null);
  assert.match(invalidRole.errors.join("; "), /participation role must be one of: attend, demo/);
});

test("normalizeParticipationInput lets signed-in people sign up and reports safety readiness blockers separately", () => {
  const normalized = normalizeParticipationInput({ signup_role: "attend" }, demoEvent, {
    id: "usr_ada",
    email: "ADA@example.COM",
    name: "Ada Lovelace",
    phone: "661-555-0100"
  });

  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.person.id, "usr_ada");
  assert.equal(normalized.person.email, "ada@example.com");
  assert.equal(normalized.readiness.ready, false);
  assert.equal(normalized.readiness.blockers[0].code, "missing_safety_contact");
  assert.deepEqual(normalized.readiness.blockers[0].fields, ["emergency_contact_name", "emergency_contact_phone"]);

  const withSafety = normalizeParticipationInput({ signup_role: "attend" }, demoEvent, {
    id: "usr_ada",
    email: "ada@example.com",
    name: "Ada Lovelace",
    emergency_contact: { name: "Charles Babbage", phone: "661-555-0100" }
  });
  assert.equal(withSafety.readiness.ready, true);
});

test("normalizeParticipationInput never trusts request-supplied person identity", () => {
  const signedIn = normalizeParticipationInput({
    user_id: "usr_victim",
    person_id: "usr_other",
    email: "victim@example.com",
    name: "Victim",
    signup_role: "attend"
  }, demoEvent, {
    id: "usr_attacker",
    email: "attacker@example.com",
    name: "Signed In User"
  });

  assert.equal(signedIn.person.id, "usr_attacker");
  assert.equal(signedIn.person.email, "victim@example.com");

  const anonymous = normalizeParticipationInput({
    user_id: "usr_victim",
    person_id: "usr_other",
    name: "Anonymous",
    email: "anon@example.com",
    signup_role: "attend",
    emergency_contact_name: "Helper",
    emergency_contact_phone: "661-555-0100"
  }, demoEvent, null);

  assert.equal(anonymous.person.id, null);
});

test("registerParticipation writes signup, emergency contact, and signed_up ledger facts", async () => {
  const db = createParticipationDb();
  const result = await registerParticipation(db, {
    person: { name: "Ada Lovelace", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace" },
    eventSeries: demoEvent,
    eventInstance: { id: "inst_demo_hours_20260722", event_slug: "demo-hours" },
    eventRole: "demo",
    safetyInput: { name: "Charles Babbage", phone: "661-555-0100", relationship: "Friend" },
    source: "domain-test",
    mailingListResult: { status: "skipped_not_configured", detail: "test" }
  });

  assert.match(result.signup.user_id, /^usr_/);
  assert.equal(result.signup.event_instance_id, "inst_demo_hours_20260722");
  assert.match(result.signup.metadata_json, /"signup_role":"demo"/);
  assert.equal(db.emergencyContacts[0].signup_id, result.signup.id);
  assert.equal(db.participantEvents[0].event_type, "signed_up");
});

test("checkInParticipant is idempotent and appends checked_in only once", async () => {
  const db = createParticipationDb();
  const registered = await registerParticipation(db, {
    person: { id: "usr_ada", name: "Ada Lovelace", email: "ada@example.com" },
    eventSeries: demoEvent,
    eventInstance: { id: "inst_demo_hours_20260722", event_slug: "demo-hours" },
    eventRole: "attend",
    source: "domain-test"
  });
  db.usersByEmail.set("ada@example.com", { id: "usr_ada", email: "ada@example.com", name: "Ada Lovelace" });
  db.usersById.set("usr_ada", { id: "usr_ada", email: "ada@example.com", name: "Ada Lovelace" });

  const first = await checkInParticipant(db, { personId: registered.signup.user_id, eventInstanceId: "inst_demo_hours_20260722", actor: "admin" });
  const second = await checkInParticipant(db, { personId: registered.signup.user_id, eventInstanceId: "inst_demo_hours_20260722", actor: "admin" });

  assert.equal(first.already_checked_in, false);
  assert.equal(second.already_checked_in, true);
  assert.equal(db.participantEvents.filter((event) => event.event_type === "checked_in").length, 1);
});

test("resolveParticipationReadiness and cancelParticipation expose participation state without schema changes", async () => {
  const db = createParticipationDb();
  const registered = await registerParticipation(db, {
    person: { name: "Ada Lovelace", email: "ada@example.com" },
    eventSeries: demoEvent,
    eventInstance: { id: "inst_demo_hours_20260722", event_slug: "demo-hours" },
    eventRole: "attend",
    source: "domain-test"
  });

  const notReady = await resolveParticipationReadiness(db, { personId: registered.signup.user_id, eventInstanceId: "inst_demo_hours_20260722" });
  assert.equal(notReady.ready, false);
  assert.equal(notReady.blockers[0].code, "missing_safety_contact");

  const cancelled = await cancelParticipation(db, { personId: registered.signup.user_id, eventInstanceId: "inst_demo_hours_20260722", actor: "admin", reason: "schedule conflict" });
  assert.equal(cancelled.already_cancelled, false);
  assert.equal(db.participantEvents.at(-1).event_type, "cancelled");
});

test("listParticipationRoster returns roster rows with safety and progression facts", async () => {
  const db = createParticipationDb();
  await registerParticipation(db, {
    person: { name: "Ada Lovelace", email: "ada@example.com" },
    eventSeries: demoEvent,
    eventInstance: { id: "inst_demo_hours_20260722", event_slug: "demo-hours" },
    eventRole: "demo",
    safetyInput: { name: "Charles Babbage", phone: "661-555-0100" },
    source: "domain-test"
  });
  const roster = await listParticipationRoster(db, { eventSlug: "demo-hours", eventInstanceId: "inst_demo_hours_20260722" });

  assert.equal(roster.length, 1);
  assert.equal(roster[0].signup_role, "demo");
  assert.equal(roster[0].emergency_contact_present, true);
  assert.deepEqual(roster[0].progression_labels, ["first-time"]);
});
