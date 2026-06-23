import { parseSignupFieldConfig } from "./events.js";
import {
  personSafetyReadiness,
  safetyProfileFromPerson,
  snapshotPersonSafetyForEvent,
  updatePersonSafetyProfile
} from "./people.js";
import { parseJsonObject, stringOrNull } from "./shared.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeParticipationInput(input = {}, eventSeries = {}, currentPerson = null) {
  const roleConfig = participationRoleConfigForEvent(eventSeries);
  const suppliedRole = normalizeRoleValue(input.signup_role ?? input.event_role ?? input.role ?? input.signupRole);
  const eventRole = suppliedRole || roleConfig.default_role || null;
  const errors = [];
  if (roleConfig.roles.length && (!eventRole || !roleConfig.roles.some((role) => role.value === eventRole))) {
    errors.push(`participation role must be one of: ${roleConfig.roles.map((role) => role.value).join(", ")}`);
  }

  const hasCurrentPerson = Boolean(currentPerson?.id || currentPerson?.email);
  const currentName = trimOrNull(currentPerson?.name) || trimOrNull(`${currentPerson?.first_name || ""} ${currentPerson?.last_name || ""}`);
  const suppliedName = trimOrNull(input.name) || trimOrNull(`${input.first_name || ""} ${input.last_name || ""}`);
  const email = hasCurrentPerson ? normalizeEmail(currentPerson?.email) : normalizeEmail(input.email);
  const name = hasCurrentPerson ? currentName || email : suppliedName || email;
  const nameParts = splitName(name);
  const person = {
    id: trimOrNull(currentPerson?.id),
    email,
    name,
    first_name: hasCurrentPerson ? trimOrNull(currentPerson?.first_name) || nameParts.firstName : trimOrNull(input.first_name) || nameParts.firstName,
    last_name: hasCurrentPerson ? trimOrNull(currentPerson?.last_name) || nameParts.lastName : trimOrNull(input.last_name) || nameParts.lastName,
    phone: hasCurrentPerson ? trimOrNull(currentPerson?.phone) : trimOrNull(input.phone),
    school: hasCurrentPerson ? trimOrNull(currentPerson?.school) : trimOrNull(input.school ?? input.university)
  };

  const emergency = normalizeSafetyInput(input);
  const currentSafety = safetyProfileFromPerson(currentPerson);
  const effectiveSafety = emergency.hasAny ? emergency.contact : currentSafety.contact;
  const readiness = personSafetyReadiness(effectiveSafety, { requireSafety: true });

  if (!eventSeries?.slug && !input.event_slug) errors.push("event slug is required");
  if (!person.name) errors.push("name is required");
  if (!EMAIL_RE.test(person.email)) errors.push("valid email is required");

  if (!hasCurrentPerson) {
    errors.push(...emergency.errors);
  } else if (emergency.hasAny && !emergency.complete) {
    errors.push(...emergency.errors);
  }

  const metadata = normalizeParticipationMetadata(input, eventRole);
  const emailListOptIn = input.email_list_opt_in !== false;
  const signup = {
    event_slug: eventSeries?.slug || trimOrNull(input.event_slug),
    email: person.email,
    name: person.name,
    first_name: person.first_name,
    last_name: person.last_name,
    phone: person.phone,
    school: person.school,
    year: trimOrNull(input.year),
    experience: trimOrNull(input.experience),
    notes: trimOrNull(input.notes || input.message),
    email_list_opt_in: emailListOptIn ? 1 : 0,
    metadata_json: stringifyJson(metadata),
    emergency_contact: emergency.contact
  };

  return {
    participation: {
      event_slug: signup.event_slug,
      event_role: eventRole,
      source: trimOrNull(input.source)
    },
    person,
    signup,
    eventRole,
    event_role: eventRole,
    roles: roleConfig.roles,
    safetyInput: emergency.hasAny ? emergency.contact : currentSafety.complete ? currentSafety.contact : null,
    readiness,
    errors
  };
}

export async function registerParticipation(db, {
  person,
  eventSeries,
  eventInstance,
  eventRole = null,
  safetyInput = null,
  source = "participation-api",
  signup = {},
  mailingListResult = null,
  now = new Date().toISOString()
} = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  if (!eventSeries?.slug) throw Object.assign(new Error("eventSeries.slug is required"), { status: 400 });
  if (!eventInstance?.id) throw Object.assign(new Error("eventInstance.id is required"), { status: 400 });

  const normalizedPerson = normalizePerson(person || signup || {});
  if (!normalizedPerson.id && !EMAIL_RE.test(normalizedPerson.email)) {
    throw Object.assign(new Error("valid email is required"), { status: 400, errors: ["valid email is required"] });
  }
  const user = normalizedPerson.id ? normalizedPerson : await upsertParticipationUser(db, normalizedPerson, now);
  if (!user?.id) throw Object.assign(new Error("person.id is required"), { status: 400 });

  const metadata = {
    ...parseJsonObject(signup.metadata_json ?? signup.metadata, {}),
    ...(eventRole ? { signup_role: normalizeRoleValue(eventRole) } : {})
  };
  const signupId = signup.id && String(signup.id).startsWith("sgn_") ? String(signup.id) : generateId("sgn");
  const savedInput = {
    event_slug: eventSeries.slug,
    event_instance_id: eventInstance.id,
    user_id: user.id,
    name: trimOrNull(signup.name) || user.name || user.email,
    first_name: trimOrNull(signup.first_name) || user.first_name || null,
    last_name: trimOrNull(signup.last_name) || user.last_name || null,
    phone: trimOrNull(signup.phone) || user.phone || null,
    school: trimOrNull(signup.school) || user.school || null,
    year: trimOrNull(signup.year),
    experience: trimOrNull(signup.experience),
    notes: trimOrNull(signup.notes),
    email_list_opt_in: signup.email_list_opt_in === 0 || signup.email_list_opt_in === false ? 0 : 1,
    metadata_json: stringifyJson(metadata),
    mailing_list_status: mailingListResult?.status || signup.mailing_list_status || "skipped_not_configured",
    mailing_list_detail: mailingListResult?.detail || signup.mailing_list_detail || "No email-list sync result supplied"
  };

  await db.prepare(`
    INSERT INTO signups (
      id, event_slug, event_instance_id, user_id, name, first_name, last_name, phone, school, year, experience, notes,
      email_list_opt_in, metadata_json, mailing_list_status, mailing_list_detail, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_instance_id, user_id) DO UPDATE SET
      name = excluded.name,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      phone = excluded.phone,
      school = excluded.school,
      year = excluded.year,
      experience = excluded.experience,
      notes = excluded.notes,
      email_list_opt_in = excluded.email_list_opt_in,
      metadata_json = excluded.metadata_json,
      mailing_list_status = excluded.mailing_list_status,
      mailing_list_detail = excluded.mailing_list_detail,
      updated_at = excluded.updated_at
  `).bind(
    signupId,
    savedInput.event_slug,
    savedInput.event_instance_id,
    savedInput.user_id,
    savedInput.name,
    savedInput.first_name,
    savedInput.last_name,
    savedInput.phone,
    savedInput.school,
    savedInput.year,
    savedInput.experience,
    savedInput.notes,
    savedInput.email_list_opt_in,
    savedInput.metadata_json,
    savedInput.mailing_list_status,
    savedInput.mailing_list_detail,
    now,
    now
  ).run();

  const savedSignup = await getParticipationSignup(db, eventSeries.slug, eventInstance.id, user.id)
    || { id: signupId, ...savedInput, created_at: now, updated_at: now, email: user.email };

  const safety = normalizeSafetyContact(safetyInput || signup.emergency_contact || safetyProfileFromPerson(user).contact || null);
  if (safety.hasAny) {
    if (!safety.complete) throw Object.assign(new Error(safety.errors.join("; ")), { status: 400, errors: safety.errors });
    await updatePersonSafetyProfile(db, { personId: user.id, safetyInput: safety.contact, now });
    await snapshotPersonSafetyForEvent(db, {
      eventInstanceId: eventInstance.id,
      personId: user.id,
      signupId: savedSignup.id,
      safetyProfile: safety.contact,
      source: source === "signed-in-event-signup" ? "signup" : source,
      now
    });
  }

  await appendParticipantEvent(db, {
    id: `evt_${savedSignup.id}_signed_up`,
    eventSlug: eventSeries.slug,
    eventInstanceId: eventInstance.id,
    userId: user.id,
    signupId: savedSignup.id,
    eventType: "signed_up",
    actor: null,
    source,
    data: null,
    occurredAt: savedSignup.created_at || now,
    now
  });

  const readiness = await resolveParticipationReadiness(db, { personId: user.id, eventInstanceId: eventInstance.id });
  return {
    participation: savedSignup,
    signup: savedSignup,
    person: user,
    eventSeries,
    eventInstance,
    eventRole: eventRole || null,
    readiness
  };
}

export async function checkInParticipant(db, { personId, eventInstanceId, actor = "admin", source = "admin-checkin", now = new Date().toISOString() } = {}) {
  if (!personId || !eventInstanceId) {
    throw Object.assign(new Error("personId and eventInstanceId are required"), { status: 400 });
  }
  const signup = await getParticipationSignupByInstanceAndPerson(db, eventInstanceId, personId);
  if (!signup) throw Object.assign(new Error("Participation not found for this event instance"), { status: 404 });
  const alreadyCheckedIn = Boolean(signup.checked_in_at);
  if (!alreadyCheckedIn) {
    await appendParticipantEvent(db, {
      id: `evt_${eventInstanceId}_${personId}_checked_in`,
      eventSlug: signup.event_slug,
      eventInstanceId,
      userId: personId,
      signupId: signup.id,
      eventType: "checked_in",
      actor,
      source,
      data: { manual: true },
      occurredAt: now,
      now
    });
  }
  const refreshed = await getParticipationSignupByInstanceAndPerson(db, eventInstanceId, personId);
  const checkedInAt = refreshed?.checked_in_at || signup.checked_in_at || now;
  return {
    participation: refreshed || { ...signup, checked_in_at: checkedInAt },
    signup: refreshed || { ...signup, checked_in_at: checkedInAt },
    checked_in_at: checkedInAt,
    already_checked_in: alreadyCheckedIn
  };
}

export async function cancelParticipation(db, { personId, eventInstanceId, actor = "admin", reason = null, source = "admin", now = new Date().toISOString() } = {}) {
  if (!personId || !eventInstanceId) {
    throw Object.assign(new Error("personId and eventInstanceId are required"), { status: 400 });
  }
  const signup = await getParticipationSignupByInstanceAndPerson(db, eventInstanceId, personId);
  if (!signup) throw Object.assign(new Error("Participation not found for this event instance"), { status: 404 });
  const alreadyCancelled = Boolean(signup.cancelled_at);
  if (!alreadyCancelled) {
    await appendParticipantEvent(db, {
      id: `evt_${eventInstanceId}_${personId}_cancelled`,
      eventSlug: signup.event_slug,
      eventInstanceId,
      userId: personId,
      signupId: signup.id,
      eventType: "cancelled",
      actor,
      source,
      data: { reason: trimOrNull(reason) },
      occurredAt: now,
      now
    });
  }
  const refreshed = await getParticipationSignupByInstanceAndPerson(db, eventInstanceId, personId);
  return {
    participation: refreshed || signup,
    signup: refreshed || signup,
    cancelled_at: refreshed?.cancelled_at || signup.cancelled_at || now,
    already_cancelled: alreadyCancelled
  };
}

export async function resolveParticipationReadiness(db, { personId, eventInstanceId } = {}) {
  if (!personId || !eventInstanceId) {
    return personSafetyReadiness(null, { requireSafety: true });
  }
  const contact = await db.prepare(`
    SELECT id, event_instance_id, user_id, signup_id, name, relationship, phone, source, created_at, updated_at
    FROM emergency_contacts
    WHERE event_instance_id = ? AND user_id = ?
  `).bind(eventInstanceId, personId).first();
  const eventReadiness = personSafetyReadiness(contact, { requireSafety: true });
  if (eventReadiness.ready) return eventReadiness;
  const person = await db.prepare("SELECT * FROM users WHERE id = ?").bind(personId).first();
  return personSafetyReadiness(person, { requireSafety: true });
}

export async function listParticipationRoster(db, { eventSlug, eventInstanceId = null } = {}) {
  if (!eventSlug) throw Object.assign(new Error("eventSlug is required"), { status: 400 });
  const where = eventInstanceId
    ? "s.event_slug = ? AND s.event_instance_id = ?"
    : "s.event_slug = ?";
  const statement = db.prepare(`
    SELECT
      u.id AS user_id,
      s.id AS signup_id,
      s.event_slug,
      s.event_instance_id,
      json_extract(s.metadata_json, '$.signup_role') AS signup_role,
      COALESCE(s.name, u.name) AS name,
      u.email,
      1 AS is_signed_up,
      COALESCE(pcs.signed_up_at, s.created_at) AS signed_up_at,
      pcs.checked_in_at,
      pcs.checked_out_at,
      pcs.cancelled_at,
      ec.name AS emergency_contact_name,
      ec.relationship AS emergency_contact_relationship,
      ec.phone AS emergency_contact_phone,
      ec.updated_at AS emergency_contact_updated_at,
      CASE WHEN ec.id IS NOT NULL AND length(trim(COALESCE(ec.name, ''))) > 0 AND length(trim(COALESCE(ec.phone, ''))) > 0 THEN 1 ELSE 0 END AS emergency_contact_present,
      (
        SELECT COUNT(DISTINCT epe.event_instance_id)
        FROM event_participant_events epe
        WHERE epe.user_id = u.id AND epe.event_type = 'checked_in'
      ) AS attendance_count,
      (
        SELECT COUNT(DISTINCT epe.event_instance_id)
        FROM event_participant_events epe
        WHERE epe.user_id = u.id
          AND epe.event_type = 'checked_in'
          AND epe.event_instance_id IS NOT NULL
          AND epe.event_instance_id <> s.event_instance_id
      ) AS prior_attendance_count
    FROM signups s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = s.user_id
    LEFT JOIN emergency_contacts ec
      ON ec.event_instance_id = s.event_instance_id AND ec.user_id = s.user_id
    WHERE ${where}
    ORDER BY pcs.checked_in_at IS NULL DESC, lower(COALESCE(s.name, u.name, u.email)) ASC
  `);
  const result = eventInstanceId
    ? await statement.bind(eventSlug, eventInstanceId).all()
    : await statement.bind(eventSlug).all();
  return (result.results || []).map(toParticipationRosterRow);
}

export async function getParticipationCockpitReadModel(db, { eventSlug, eventInstanceId } = {}) {
  const roster = (await listParticipationRoster(db, { eventSlug, eventInstanceId }))
    .map(toParticipationCockpitRosterRow);
  return {
    summary: summarizeParticipationCockpitRoster(roster),
    roster
  };
}

export function summarizeParticipationCockpitRoster(roster = []) {
  return {
    signed_up_count: roster.length,
    checked_in_count: roster.filter((row) => row.checked_in_at).length,
    missing_emergency_contact_count: roster.filter((row) => !row.emergency_contact_present).length,
    repeat_attendee_count: roster.filter(isRepeatAttendee).length
  };
}

function toParticipationCockpitRosterRow(row = {}) {
  return {
    user_id: row.user_id,
    signup_id: row.signup_id,
    event_instance_id: row.event_instance_id,
    signup_role: row.signup_role || null,
    name: row.name,
    email: row.email,
    is_signed_up: Boolean(row.is_signed_up),
    signed_up_at: row.signed_up_at,
    checked_in_at: row.checked_in_at,
    emergency_contact: row.emergency_contact || null,
    emergency_contact_present: Boolean(row.emergency_contact_present),
    attendance_count: Number(row.attendance_count || 0),
    prior_attendance_count: Number(row.prior_attendance_count || 0),
    progression_labels: Array.isArray(row.progression_labels) ? row.progression_labels : progressionLabels(row.attendance_count, row.prior_attendance_count)
  };
}

function toParticipationRosterRow(row = {}) {
  const attendanceCount = Number(row.attendance_count || 0);
  const priorAttendanceCount = Number(row.prior_attendance_count || 0);
  const emergencyContactPresent = Boolean(row.emergency_contact_present);
  return {
    user_id: row.user_id,
    signup_id: row.signup_id,
    event_slug: row.event_slug || null,
    event_instance_id: row.event_instance_id,
    signup_role: row.signup_role || null,
    event_role: row.signup_role || null,
    name: row.name,
    email: row.email,
    is_signed_up: Boolean(row.is_signed_up),
    signed_up_at: row.signed_up_at,
    checked_in_at: row.checked_in_at,
    checked_out_at: row.checked_out_at || null,
    cancelled_at: row.cancelled_at || null,
    emergency_contact: emergencyContactPresent ? {
      name: row.emergency_contact_name,
      relationship: row.emergency_contact_relationship || null,
      phone: row.emergency_contact_phone,
      updated_at: row.emergency_contact_updated_at || null
    } : null,
    emergency_contact_present: emergencyContactPresent,
    attendance_count: attendanceCount,
    prior_attendance_count: priorAttendanceCount,
    progression_labels: progressionLabels(attendanceCount, priorAttendanceCount)
  };
}

async function getParticipationSignup(db, eventSlug, eventInstanceId, userId) {
  if (!eventSlug || !eventInstanceId || !userId) return null;
  return await db.prepare(`
    SELECT
      s.*,
      json_extract(s.metadata_json, '$.signup_role') AS signup_role,
      u.email,
      COALESCE(s.name, u.name) AS name,
      COALESCE(s.first_name, u.first_name) AS first_name,
      COALESCE(s.last_name, u.last_name) AS last_name,
      COALESCE(s.phone, u.phone) AS phone,
      COALESCE(s.school, u.school) AS school,
      pcs.signed_up_at,
      pcs.checked_in_at,
      pcs.checked_out_at,
      pcs.cancelled_at
    FROM signups s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = s.user_id
    WHERE s.event_slug = ? AND s.event_instance_id = ? AND s.user_id = ?
  `).bind(eventSlug, eventInstanceId, userId).first();
}

async function getParticipationSignupByInstanceAndPerson(db, eventInstanceId, userId) {
  if (!eventInstanceId || !userId) return null;
  return await db.prepare(`
    SELECT
      s.*,
      json_extract(s.metadata_json, '$.signup_role') AS signup_role,
      u.email,
      COALESCE(s.name, u.name) AS name,
      COALESCE(s.first_name, u.first_name) AS first_name,
      COALESCE(s.last_name, u.last_name) AS last_name,
      COALESCE(s.phone, u.phone) AS phone,
      COALESCE(s.school, u.school) AS school,
      pcs.signed_up_at,
      pcs.checked_in_at,
      pcs.checked_out_at,
      pcs.cancelled_at
    FROM signups s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = s.user_id
    WHERE s.event_instance_id = ? AND s.user_id = ?
  `).bind(eventInstanceId, userId).first();
}

async function upsertParticipationUser(db, input, now) {
  await db.prepare(`
    INSERT INTO users (
      id, email, name, first_name, last_name, phone, school, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = COALESCE(excluded.name, users.name),
      first_name = COALESCE(excluded.first_name, users.first_name),
      last_name = COALESCE(excluded.last_name, users.last_name),
      phone = COALESCE(excluded.phone, users.phone),
      school = COALESCE(excluded.school, users.school),
      metadata_json = COALESCE(excluded.metadata_json, users.metadata_json),
      updated_at = excluded.updated_at
  `).bind(
    input.id || generateId("usr"),
    input.email,
    input.name,
    input.first_name,
    input.last_name,
    input.phone,
    input.school,
    stringifyJson(input.metadata || input.metadata_json || null),
    now,
    now
  ).run();
  return await db.prepare("SELECT * FROM users WHERE email = ?").bind(input.email).first();
}

async function upsertParticipationSafetyContact(db, { eventInstanceId, userId, signupId = null, contact, source = "signup", now }) {
  await db.prepare(`
    INSERT INTO emergency_contacts (
      id, event_instance_id, user_id, signup_id, name, relationship, phone, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_instance_id, user_id) DO UPDATE SET
      signup_id = COALESCE(excluded.signup_id, emergency_contacts.signup_id),
      name = excluded.name,
      relationship = excluded.relationship,
      phone = excluded.phone,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).bind(
    generateId("emc"),
    eventInstanceId,
    userId,
    signupId,
    contact.name,
    contact.relationship || null,
    contact.phone,
    source,
    now,
    now
  ).run();
}

async function appendParticipantEvent(db, { id, eventSlug, eventInstanceId, userId, signupId, eventType, actor = null, source = "system", data = null, occurredAt, now }) {
  await db.prepare(`
    INSERT OR IGNORE INTO event_participant_events (
      id, event_slug, event_instance_id, user_id, signup_id, event_type, actor, source, data_json, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    eventSlug,
    eventInstanceId,
    userId,
    signupId,
    eventType,
    actor,
    source,
    stringifyJson(data),
    occurredAt,
    now
  ).run();
}

function participationRoleConfigForEvent(event = {}) {
  try {
    const config = parseSignupFieldConfig(event);
    return {
      roles: config.roles || [],
      default_role: config.default_role || null,
      label: config.label || config.role_label || "How do you want to participate?"
    };
  } catch {
    const config = parseJsonObject(event.signup_fields_json, {});
    const rawRoles = Array.isArray(config.roles) ? config.roles : Array.isArray(config.signup_roles) ? config.signup_roles : [];
    const roles = rawRoles.map((role) => {
      const source = role && typeof role === "object" ? role : { value: role, label: role };
      const value = normalizeRoleValue(source.value || source.id || source.key || source.label);
      return value ? { value, label: stringOrNull(source.label) || titleize(value), description: stringOrNull(source.description || source.help || source.hint) } : null;
    }).filter(Boolean);
    const requestedDefault = normalizeRoleValue(config.default_role || config.defaultRole);
    return { roles, default_role: roles.find((role) => role.value === requestedDefault)?.value || roles[0]?.value || null, label: stringOrNull(config.role_label || config.signup_role_label) || "How do you want to participate?" };
  }
}

function normalizeParticipationMetadata(input, eventRole) {
  const metadata = { ...parseJsonObject(input.metadata, {}) };
  for (const key of ["major", "dietary", "tshirt", "coc", "source", "referrer"]) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") metadata[key] = input[key];
  }
  if (eventRole) metadata.signup_role = eventRole;
  return metadata;
}

function safetyFromPerson(person) {
  if (!person) return { contact: null, complete: false };
  if (person.emergency_contact && typeof person.emergency_contact === "object") {
    return normalizeSafetyContact(person.emergency_contact);
  }
  if (person.safety_contact && typeof person.safety_contact === "object") {
    return normalizeSafetyContact(person.safety_contact);
  }
  const presentFlag = person.emergency_contact_present || person.safety_contact_present;
  const contact = {
    name: trimOrNull(person.emergency_contact_name ?? person.safety_contact_name),
    phone: trimOrNull(person.emergency_contact_phone ?? person.safety_contact_phone),
    relationship: trimOrNull(person.emergency_contact_relationship ?? person.safety_contact_relationship)
  };
  if (presentFlag && !contact.name && !contact.phone) return { contact: { name: "on file", phone: "on file", relationship: null }, complete: true, hasAny: true, errors: [] };
  return normalizeSafetyContact(contact);
}

function normalizeSafetyInput(input = {}) {
  const nested = input.emergency_contact && typeof input.emergency_contact === "object" ? input.emergency_contact : {};
  return normalizeSafetyContact({
    name: input.emergency_contact_name ?? nested.name,
    phone: input.emergency_contact_phone ?? nested.phone,
    relationship: input.emergency_contact_relationship ?? nested.relationship
  });
}

function normalizeSafetyContact(contact = {}) {
  const normalized = {
    name: trimOrNull(contact?.name),
    phone: trimOrNull(contact?.phone),
    relationship: trimOrNull(contact?.relationship)
  };
  const errors = [];
  if (!normalized.name) errors.push("emergency contact name is required");
  if (!normalized.phone) errors.push("emergency contact phone is required");
  const phoneDigits = String(normalized.phone || "").replace(/\D/g, "");
  if (normalized.phone && phoneDigits.length < 7) errors.push("emergency contact phone must include at least 7 digits");
  return {
    contact: normalized,
    errors,
    complete: errors.length === 0,
    hasAny: Boolean(normalized.name || normalized.phone || normalized.relationship)
  };
}

function participationReadinessFromSafety(contact, { requireSafety = true } = {}) {
  if (!requireSafety) return { ready: true, blockers: [], missing_safety_fields: [] };
  const normalized = normalizeSafetyContact(contact || {});
  if (normalized.complete) return { ready: true, blockers: [], missing_safety_fields: [], safety_contact_present: true };
  const fields = [];
  if (!normalized.contact.name) fields.push("emergency_contact_name");
  if (!normalized.contact.phone) fields.push("emergency_contact_phone");
  return {
    ready: false,
    blockers: [{ code: "missing_safety_contact", message: "Emergency contact is required before participation is fully ready.", fields }],
    missing_safety_fields: fields,
    safety_contact_present: false
  };
}

function normalizePerson(input = {}) {
  const name = trimOrNull(input.name) || trimOrNull(`${input.first_name || ""} ${input.last_name || ""}`);
  const parts = splitName(name);
  return {
    id: trimOrNull(input.id ?? input.user_id ?? input.person_id),
    email: normalizeEmail(input.email),
    name: name || normalizeEmail(input.email),
    first_name: trimOrNull(input.first_name) || parts.firstName,
    last_name: trimOrNull(input.last_name) || parts.lastName,
    phone: trimOrNull(input.phone),
    school: trimOrNull(input.school ?? input.university),
    metadata: input.metadata,
    metadata_json: input.metadata_json
  };
}

function progressionLabels(attendanceCount, priorAttendanceCount = 0) {
  const count = Number(attendanceCount || 0);
  const priorCount = Number(priorAttendanceCount || 0);
  if (count >= 3) return ["repeat", "3x attendee"];
  if (count >= 2 || priorCount >= 1) return ["repeat"];
  return ["first-time"];
}

function isRepeatAttendee(row = {}) {
  return (row.progression_labels || []).includes("repeat");
}

function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRoleValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  return normalized || null;
}

function titleize(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function trimOrNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function stringifyJson(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ value });
    }
  }
  return JSON.stringify(value);
}

function generateId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
