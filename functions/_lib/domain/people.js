import { parseJsonObject, stringOrNull } from "./shared.js";

export function normalizePersonSafetyProfile(input = {}, current = null) {
  const source = safetyProfileSource(input, current);
  const contact = {
    name: stringOrNull(source.name ?? source.emergency_contact_name ?? source.safety_contact_name),
    phone: stringOrNull(source.phone ?? source.emergency_contact_phone ?? source.safety_contact_phone),
    relationship: stringOrNull(source.relationship ?? source.emergency_contact_relationship ?? source.safety_contact_relationship)
  };
  const errors = [];
  if (!contact.name) errors.push("emergency contact name is required");
  if (!contact.phone) errors.push("emergency contact phone is required");
  const phoneDigits = String(contact.phone || "").replace(/\D/g, "");
  if (contact.phone && phoneDigits.length < 7) errors.push("emergency contact phone must include at least 7 digits");

  const hasAny = Boolean(contact.name || contact.phone || contact.relationship);
  const complete = hasAny && errors.length === 0;
  const profile = hasAny ? {
    emergency_contact: contact,
    updated_at: stringOrNull(source.updated_at ?? current?.updated_at) || null
  } : null;
  return {
    profile,
    contact: hasAny ? contact : null,
    emergency_contact: hasAny ? contact : null,
    errors,
    complete,
    hasAny,
    readiness: readinessFromNormalized({ contact: hasAny ? contact : null, complete, hasAny })
  };
}

export function safetyProfileFromPerson(person = null) {
  if (!person) return normalizePersonSafetyProfile(null);
  if (person.safety_profile && typeof person.safety_profile === "object") {
    return normalizePersonSafetyProfile(person.safety_profile, person.safety_profile);
  }
  const metadata = parseJsonObject(person.metadata_json ?? person.metadata, {});
  if (metadata.safety_profile && typeof metadata.safety_profile === "object") {
    return normalizePersonSafetyProfile(metadata.safety_profile, metadata.safety_profile);
  }
  if (person.emergency_contact && typeof person.emergency_contact === "object") {
    return normalizePersonSafetyProfile(person.emergency_contact, person.emergency_contact);
  }
  if (person.safety_contact && typeof person.safety_contact === "object") {
    return normalizePersonSafetyProfile(person.safety_contact, person.safety_contact);
  }
  const presentFlag = person.emergency_contact_present || person.safety_contact_present;
  const fromColumns = normalizePersonSafetyProfile({
    name: person.emergency_contact_name ?? person.safety_contact_name,
    phone: person.emergency_contact_phone ?? person.safety_contact_phone,
    relationship: person.emergency_contact_relationship ?? person.safety_contact_relationship,
    updated_at: person.emergency_contact_updated_at ?? person.safety_contact_updated_at
  });
  if (presentFlag && !fromColumns.hasAny) {
    return {
      profile: { emergency_contact: { name: "on file", phone: "on file", relationship: null }, updated_at: null },
      contact: { name: "on file", phone: "on file", relationship: null },
      emergency_contact: { name: "on file", phone: "on file", relationship: null },
      errors: [],
      complete: true,
      hasAny: true,
      readiness: { ready: true, blockers: [], missing_safety_fields: [], safety_contact_present: true }
    };
  }
  return fromColumns;
}

export function personSafetyReadiness(personOrSafetyProfile = null, { requireSafety = true } = {}) {
  if (!requireSafety) return { ready: true, blockers: [], missing_safety_fields: [], safety_contact_present: true };
  const normalized = looksLikePersonRow(personOrSafetyProfile)
    ? safetyProfileFromPerson(personOrSafetyProfile)
    : normalizePersonSafetyProfile(personOrSafetyProfile);
  return readinessFromNormalized(normalized);
}

function readinessFromNormalized(normalized) {
  if (normalized.complete) {
    return { ready: true, blockers: [], missing_safety_fields: [], safety_contact_present: true };
  }
  const fields = [];
  if (!normalized.contact?.name) fields.push("emergency_contact_name");
  if (!normalized.contact?.phone) fields.push("emergency_contact_phone");
  return {
    ready: false,
    blockers: [{ code: "missing_safety_contact", message: "Emergency contact is required before participation is fully ready.", fields }],
    missing_safety_fields: fields,
    safety_contact_present: false
  };
}

export async function updatePersonSafetyProfile(db, { personId, safetyInput, now = new Date().toISOString() } = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  if (!personId) throw Object.assign(new Error("personId is required"), { status: 400 });
  const normalized = normalizePersonSafetyProfile(safetyInput);
  if (!normalized.hasAny) return await selectPersonById(db, personId);
  if (!normalized.complete) throw Object.assign(new Error(normalized.errors.join("; ")), { status: 400, errors: normalized.errors });
  const existing = await selectPersonById(db, personId);
  if (!existing) throw Object.assign(new Error("User not found"), { status: 404 });
  const metadata = {
    ...parseJsonObject(existing.metadata_json, {}),
    safety_profile: {
      emergency_contact: normalized.contact,
      updated_at: now
    }
  };
  await db.prepare(`
    UPDATE users
    SET metadata_json = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(JSON.stringify(metadata), now, personId).run();
  return await selectPersonById(db, personId) || { ...existing, metadata_json: JSON.stringify(metadata), updated_at: now };
}

export async function snapshotPersonSafetyForEvent(db, {
  personId,
  eventInstanceId,
  signupId = null,
  safetyProfile = null,
  source = "person_safety_profile",
  now = new Date().toISOString()
} = {}) {
  if (!db) throw Object.assign(new Error("db is required"), { status: 500 });
  if (!personId || !eventInstanceId) {
    throw Object.assign(new Error("personId and eventInstanceId are required"), { status: 400 });
  }
  const normalized = normalizePersonSafetyProfile(safetyProfile);
  if (!normalized.hasAny) return null;
  if (!normalized.complete) throw Object.assign(new Error(normalized.errors.join("; ")), { status: 400, errors: normalized.errors });
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
    personId,
    signupId,
    normalized.contact.name,
    normalized.contact.relationship || null,
    normalized.contact.phone,
    source,
    now,
    now
  ).run();
  return normalized.contact;
}

export function safetyProfileInputFromPatch(input = {}) {
  if (!input || typeof input !== "object") return null;
  if (input.safety_profile && typeof input.safety_profile === "object") return input.safety_profile;
  if (input.person_safety_profile && typeof input.person_safety_profile === "object") return input.person_safety_profile;
  if (input.emergency_contact && typeof input.emergency_contact === "object") return input.emergency_contact;
  if (input.emergency_contact_name !== undefined || input.emergency_contact_phone !== undefined || input.emergency_contact_relationship !== undefined) {
    return {
      name: input.emergency_contact_name,
      phone: input.emergency_contact_phone,
      relationship: input.emergency_contact_relationship
    };
  }
  return null;
}

export function applySafetyProfileToMetadata(metadataInput, safetyInput, { now = new Date().toISOString() } = {}) {
  const metadata = parseJsonObject(metadataInput, {});
  const normalized = normalizePersonSafetyProfile(safetyInput);
  if (!normalized.hasAny) return { metadata, safety: normalized, changed: false };
  if (!normalized.complete) return { metadata, safety: normalized, changed: false };
  return {
    metadata: {
      ...metadata,
      safety_profile: {
        emergency_contact: normalized.contact,
        updated_at: now
      }
    },
    safety: normalized,
    changed: true
  };
}

function safetyProfileSource(input = {}, current = null) {
  if (!input || typeof input !== "object") input = {};
  const nestedSafety = input.safety_profile && typeof input.safety_profile === "object" ? input.safety_profile : null;
  const nestedPersonSafety = input.person_safety_profile && typeof input.person_safety_profile === "object" ? input.person_safety_profile : null;
  const nestedEmergency = input.emergency_contact && typeof input.emergency_contact === "object" ? input.emergency_contact : null;
  const nestedSafetyContact = input.safety_contact && typeof input.safety_contact === "object" ? input.safety_contact : null;
  const nested = nestedSafety || nestedPersonSafety || nestedEmergency || nestedSafetyContact || input;
  const currentNested = current?.safety_profile || current?.person_safety_profile || current?.emergency_contact || current?.safety_contact || current || {};
  return { ...currentNested, ...nested };
}

function looksLikePersonRow(value) {
  return Boolean(value && typeof value === "object" && (
    value.metadata_json !== undefined
    || value.metadata !== undefined
    || value.safety_profile !== undefined
    || value.emergency_contact_present !== undefined
    || value.safety_contact_present !== undefined
  ));
}

async function selectPersonById(db, personId) {
  return await db.prepare("SELECT * FROM users WHERE id = ?").bind(personId).first();
}

function generateId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
