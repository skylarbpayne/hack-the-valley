const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPEN_STATUSES = new Set(["draft", "open", "closed", "archived"]);

export function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers || {}) }
  });
}

export function methodNotAllowed(methods) {
  return jsonResponse({ error: `Method not allowed. Use ${methods.join(", ")}.` }, {
    status: 405,
    headers: { Allow: methods.join(", ") }
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

export function requireAdmin(request, env) {
  const configuredToken = env.HTV_ADMIN_TOKEN || env.ADMIN_TOKEN;
  if (!configuredToken) {
    throw Object.assign(new Error("HTV_ADMIN_TOKEN is not configured"), { status: 500 });
  }

  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerToken = request.headers.get("X-Admin-Token") || "";
  const token = bearer || headerToken;

  if (token !== configuredToken) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
}

export function getDb(env) {
  const db = env.HTV_DB || env.SUBMISSIONS_DB || env.DB;
  if (!db) {
    throw Object.assign(new Error("HTV_DB D1 binding is not configured"), { status: 500 });
  }
  return db;
}

export function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function normalizeEventInput(input, existing = {}) {
  const title = String(input.title ?? existing.title ?? "").trim();
  const explicitSlug = input.slug !== undefined && input.slug !== null && String(input.slug).trim() !== "";
  const slug = explicitSlug ? String(input.slug).trim() : slugify(title || existing.slug);
  const status = String(input.status ?? existing.status ?? "draft").trim().toLowerCase();

  const event = {
    slug,
    title,
    description: trimOrNull(input.description ?? existing.description),
    starts_at: trimOrNull(input.starts_at ?? existing.starts_at),
    ends_at: trimOrNull(input.ends_at ?? existing.ends_at),
    venue_name: trimOrNull(input.venue_name ?? existing.venue_name),
    venue_address: trimOrNull(input.venue_address ?? existing.venue_address),
    capacity: input.capacity ?? existing.capacity ?? null,
    status,
    image_url: trimOrNull(input.image_url ?? existing.image_url),
    page_content: trimOrNull(input.page_content ?? existing.page_content),
    signup_fields_json: stringifyJson(input.signup_fields ?? input.signup_fields_json ?? existing.signup_fields_json ?? null),
    recurrence_rule_json: stringifyJson(input.recurrence_rule ?? input.recurrence_rule_json ?? existing.recurrence_rule_json ?? null)
  };

  const errors = [];
  if (!event.title) errors.push("title is required");
  if (!event.slug || !SLUG_RE.test(event.slug)) errors.push("slug must use lowercase letters, numbers, and hyphens");
  if (!OPEN_STATUSES.has(event.status)) errors.push("status must be draft, open, closed, or archived");
  if (event.capacity !== null && event.capacity !== "" && (!Number.isInteger(Number(event.capacity)) || Number(event.capacity) < 1)) {
    errors.push("capacity must be a positive integer when provided");
  }
  event.capacity = event.capacity === null || event.capacity === "" ? null : Number(event.capacity);

  return { event, errors };
}

export function normalizeSignupInput(input, eventSlug) {
  const email = normalizeEmail(input.email);
  const name = String(input.name || `${input.first_name || ""} ${input.last_name || ""}`).trim();
  const nameParts = splitName(name);
  const firstName = String(input.first_name || nameParts.firstName).trim();
  const lastName = String(input.last_name || nameParts.lastName).trim();
  const wantsEmailList = input.email_list_opt_in !== false;

  const signup = {
    event_slug: eventSlug,
    email,
    name,
    first_name: firstName,
    last_name: lastName,
    phone: trimOrNull(input.phone),
    school: trimOrNull(input.school || input.university),
    year: trimOrNull(input.year),
    experience: trimOrNull(input.experience),
    notes: trimOrNull(input.notes || input.message),
    email_list_opt_in: wantsEmailList ? 1 : 0,
    metadata_json: stringifyJson(input.metadata || buildLegacyMetadata(input))
  };

  const errors = [];
  if (!signup.event_slug) errors.push("event slug is required");
  if (!signup.name) errors.push("name is required");
  if (!EMAIL_RE.test(email)) errors.push("valid email is required");

  return { signup, errors };
}

function buildLegacyMetadata(input) {
  const metadata = {};
  for (const key of ["major", "dietary", "tshirt", "coc", "source", "referrer"]) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") metadata[key] = input[key];
  }
  return metadata;
}

export function generateId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

export async function listEvents(db, { includeArchived = false } = {}) {
  const baseSelect = `
    SELECT
      e.*,
      (SELECT COUNT(*) FROM event_instances ei WHERE ei.event_slug = e.slug) AS instance_count,
      (SELECT ei.id FROM event_instances ei WHERE ei.event_slug = e.slug AND ei.status = 'open' ORDER BY ei.starts_at IS NULL, ei.starts_at ASC, ei.created_at ASC LIMIT 1) AS active_instance_id,
      (SELECT ei.instance_key FROM event_instances ei WHERE ei.event_slug = e.slug AND ei.status = 'open' ORDER BY ei.starts_at IS NULL, ei.starts_at ASC, ei.created_at ASC LIMIT 1) AS active_instance_key
    FROM events e
  `;
  const sql = includeArchived
    ? `${baseSelect} ORDER BY COALESCE(e.starts_at, e.created_at) DESC`
    : `${baseSelect} WHERE e.status != 'archived' ORDER BY COALESCE(e.starts_at, e.created_at) DESC`;
  const result = await db.prepare(sql).all();
  return result.results || [];
}

export async function getEvent(db, slug) {
  return await db.prepare("SELECT * FROM events WHERE slug = ?").bind(slug).first();
}

function instanceKeyFromStartsAt(value) {
  if (!value) return "unscheduled";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return slugify(value) || "unscheduled";
  return parsed.toISOString().slice(0, 10);
}

function instanceIdFor(eventSlug, instanceKey) {
  return `inst_${String(eventSlug).replaceAll("-", "_")}_${String(instanceKey).replaceAll("-", "_")}`;
}

export async function upsertEventInstance(db, event) {
  const instanceKey = instanceKeyFromStartsAt(event.starts_at);
  const instanceId = instanceIdFor(event.slug, instanceKey);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO event_instances (
      id, event_slug, instance_key, title, starts_at, ends_at, venue_name, venue_address, capacity, status,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_slug, instance_key) DO UPDATE SET
      title = excluded.title,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      venue_name = excluded.venue_name,
      venue_address = excluded.venue_address,
      capacity = excluded.capacity,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).bind(
    instanceId,
    event.slug,
    instanceKey,
    event.title,
    event.starts_at,
    event.ends_at,
    event.venue_name,
    event.venue_address,
    event.capacity,
    event.status,
    null,
    event.created_at || now,
    now
  ).run();
  return await db.prepare("SELECT * FROM event_instances WHERE id = ?").bind(instanceId).first();
}

export async function resolveSignupEventInstance(db, eventSlug) {
  return await db.prepare(`
    SELECT *
    FROM event_instances
    WHERE event_slug = ? AND status = 'open'
    ORDER BY starts_at IS NULL, starts_at ASC, created_at ASC
    LIMIT 1
  `).bind(eventSlug).first();
}

export async function listEventInstances(db, eventSlug) {
  const result = await db.prepare(`
    SELECT *
    FROM event_instances
    WHERE event_slug = ?
    ORDER BY starts_at IS NULL, starts_at ASC, created_at ASC
  `).bind(eventSlug).all();
  return result.results || [];
}

export async function upsertEvent(db, input, existing = {}) {
  const { event, errors } = normalizeEventInput(input, existing);
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO events (
      slug, title, description, starts_at, ends_at, venue_name, venue_address, capacity, status,
      image_url, page_content, signup_fields_json, recurrence_rule_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      venue_name = excluded.venue_name,
      venue_address = excluded.venue_address,
      capacity = excluded.capacity,
      status = excluded.status,
      image_url = excluded.image_url,
      page_content = excluded.page_content,
      signup_fields_json = excluded.signup_fields_json,
      recurrence_rule_json = excluded.recurrence_rule_json,
      updated_at = excluded.updated_at
  `).bind(
    event.slug,
    event.title,
    event.description,
    event.starts_at,
    event.ends_at,
    event.venue_name,
    event.venue_address,
    event.capacity,
    event.status,
    event.image_url,
    event.page_content,
    event.signup_fields_json,
    event.recurrence_rule_json,
    now,
    now
  ).run();

  const savedEvent = await getEvent(db, event.slug);
  await upsertEventInstance(db, savedEvent);
  return savedEvent;
}

export async function listUsers(db, { limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
  const result = await db.prepare(`
    SELECT
      u.id,
      u.email,
      u.name,
      u.first_name,
      u.last_name,
      u.phone,
      u.school,
      u.metadata_json,
      u.created_at,
      u.updated_at,
      COUNT(s.id) AS signup_count
    FROM users u
    LEFT JOIN signups s ON s.user_id = u.id
    GROUP BY u.id
    ORDER BY u.updated_at DESC, u.created_at DESC
    LIMIT ?
  `).bind(safeLimit).all();
  return result.results || [];
}

export async function listSignups(db, eventSlug, { eventInstanceId = null } = {}) {
  const where = eventInstanceId
    ? "s.event_slug = ? AND s.event_instance_id = ?"
    : "s.event_slug = ?";
  const statement = db.prepare(`
    SELECT
      s.*,
      ei.instance_key,
      ei.starts_at AS instance_starts_at,
      ei.status AS instance_status,
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
    LEFT JOIN event_instances ei ON ei.id = s.event_instance_id
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = s.user_id
    WHERE ${where}
    ORDER BY COALESCE(ei.starts_at, s.created_at) ASC, s.created_at ASC
  `);
  const result = eventInstanceId
    ? await statement.bind(eventSlug, eventInstanceId).all()
    : await statement.bind(eventSlug).all();
  return result.results || [];
}

export async function upsertUser(db, input) {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) {
    throw Object.assign(new Error("valid email is required"), { status: 400 });
  }

  const now = new Date().toISOString();
  const id = input.id && String(input.id).startsWith("usr_") ? String(input.id) : generateId("usr");
  const name = trimOrNull(input.name || `${input.first_name || ""} ${input.last_name || ""}`);
  const metadata = stringifyJson(input.metadata || input.metadata_json || null);

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
    id,
    email,
    name,
    trimOrNull(input.first_name),
    trimOrNull(input.last_name),
    trimOrNull(input.phone),
    trimOrNull(input.school || input.university),
    metadata,
    now,
    now
  ).run();

  return await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
}

export async function upsertSignup(db, eventSlug, input, mailingListResult, eventInstance = null) {
  const { signup, errors } = normalizeSignupInput(input, eventSlug);
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

  const user = await upsertUser(db, signup);
  const now = new Date().toISOString();
  const signupId = input.id && String(input.id).startsWith("sgn_") ? String(input.id) : generateId("sgn");
  const resolvedInstance = eventInstance || await resolveSignupEventInstance(db, eventSlug);
  if (!resolvedInstance) {
    throw Object.assign(new Error("No open instance is available for this event"), { status: 409 });
  }

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
    signup.event_slug,
    resolvedInstance.id,
    user.id,
    signup.name,
    signup.first_name,
    signup.last_name,
    signup.phone,
    signup.school,
    signup.year,
    signup.experience,
    signup.notes,
    signup.email_list_opt_in,
    signup.metadata_json,
    mailingListResult.status,
    mailingListResult.detail,
    now,
    now
  ).run();

  const savedSignup = await db.prepare(`
    SELECT s.*, u.email
    FROM signups s
    JOIN users u ON u.id = s.user_id
    WHERE s.event_slug = ? AND s.event_instance_id = ? AND s.user_id = ?
  `).bind(signup.event_slug, resolvedInstance.id, user.id).first();

  await db.prepare(`
    INSERT OR IGNORE INTO event_participant_events (
      id, event_slug, event_instance_id, user_id, signup_id, event_type, actor, source, data_json, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'signed_up', NULL, 'signup-api', NULL, ?, ?)
  `).bind(
    `evt_${savedSignup.id}_signed_up`,
    savedSignup.event_slug,
    savedSignup.event_instance_id,
    savedSignup.user_id,
    savedSignup.id,
    savedSignup.created_at || now,
    now
  ).run();

  return savedSignup;
}

export async function getUserById(db, userId) {
  if (!userId) return null;
  return await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
}

export async function getEventInstance(db, eventSlug, eventInstanceId) {
  if (!eventInstanceId) return null;
  return await db.prepare("SELECT * FROM event_instances WHERE event_slug = ? AND id = ?").bind(eventSlug, eventInstanceId).first();
}

async function getSignupByInstanceAndUser(db, eventSlug, eventInstanceId, userId) {
  if (!eventInstanceId || !userId) return null;
  return await db.prepare(`
    SELECT
      s.*,
      ei.instance_key,
      ei.starts_at AS instance_starts_at,
      ei.status AS instance_status,
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
    LEFT JOIN event_instances ei ON ei.id = s.event_instance_id
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = s.user_id
    WHERE s.event_slug = ? AND s.event_instance_id = ? AND s.user_id = ?
  `).bind(eventSlug, eventInstanceId, userId).first();
}

export async function searchCheckinCandidates(db, eventSlug, { eventInstanceId, query = "", limit = 25 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const trimmed = String(query || "").trim().toLowerCase();
  if (!eventInstanceId) {
    throw Object.assign(new Error("event_instance_id is required for check-in search"), { status: 400 });
  }
  if (!trimmed) {
    const result = await db.prepare(`
      SELECT
        u.id,
        u.email,
        COALESCE(s.name, u.name) AS name,
        COALESCE(s.first_name, u.first_name) AS first_name,
        COALESCE(s.last_name, u.last_name) AS last_name,
        COALESCE(s.phone, u.phone) AS phone,
        s.id AS signup_id,
        s.event_slug,
        s.event_instance_id,
        s.email_list_opt_in,
        1 AS is_signed_up,
        pcs.checked_in_at
      FROM signups s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN event_participant_current_state pcs
        ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = u.id
      WHERE s.event_slug = ? AND s.event_instance_id = ?
      ORDER BY pcs.checked_in_at IS NULL DESC, lower(COALESCE(s.name, u.name, u.email)) ASC
      LIMIT ${safeLimit}
    `).bind(eventSlug, eventInstanceId).all();
    return result.results || [];
  }
  const like = `%${trimmed}%`;
  const result = await db.prepare(`
    SELECT
      u.id,
      u.email,
      u.name,
      u.first_name,
      u.last_name,
      u.phone,
      s.id AS signup_id,
      s.event_slug,
      s.event_instance_id,
      s.email_list_opt_in,
      CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS is_signed_up,
      pcs.checked_in_at
    FROM users u
    LEFT JOIN signups s
      ON s.user_id = u.id AND s.event_instance_id = ?
    LEFT JOIN event_participant_current_state pcs
      ON pcs.event_instance_id = s.event_instance_id AND pcs.user_id = u.id
    WHERE lower(u.email) LIKE ?
       OR lower(COALESCE(u.name, '')) LIKE ?
       OR lower(trim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))) LIKE ?
    ORDER BY is_signed_up DESC, pcs.checked_in_at IS NULL DESC, lower(COALESCE(u.name, u.email)) ASC
    LIMIT ${safeLimit}
  `).bind(eventInstanceId, like, like, like).all();
  return result.results || [];
}

export async function checkInAttendee(db, event, input, { eventInstance = null, actor = "admin", source = "admin-checkin", syncEmailList = null } = {}) {
  const resolvedInstance = eventInstance || await resolveSignupEventInstance(db, event.slug);
  if (!resolvedInstance) {
    throw Object.assign(new Error("No open instance is available for this event"), { status: 409 });
  }

  let userInput = { ...input };
  if (input.user_id && (!input.email || !input.name)) {
    const existingUser = await getUserById(db, input.user_id);
    if (!existingUser) throw Object.assign(new Error("User not found"), { status: 404 });
    userInput = {
      ...existingUser,
      ...input,
      email: input.email || existingUser.email,
      name: input.name || existingUser.name || `${existingUser.first_name || ""} ${existingUser.last_name || ""}`.trim(),
      first_name: input.first_name || existingUser.first_name,
      last_name: input.last_name || existingUser.last_name,
      phone: input.phone || existingUser.phone,
      school: input.school || existingUser.school
    };
  }

  let savedSignup = input.user_id
    ? await getSignupByInstanceAndUser(db, event.slug, resolvedInstance.id, input.user_id)
    : null;

  if (!savedSignup) {
    const { signup, errors } = normalizeSignupInput(userInput, event.slug);
    if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
    const mailingListResult = syncEmailList
      ? await syncEmailList(signup)
      : { status: "skipped_not_configured", detail: "No email-list sync callback configured" };
    savedSignup = await upsertSignup(db, event.slug, userInput, mailingListResult, resolvedInstance);
  }

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT OR IGNORE INTO event_participant_events (
      id, event_slug, event_instance_id, user_id, signup_id, event_type, actor, source, data_json, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'checked_in', ?, ?, ?, ?, ?)
  `).bind(
    `evt_${resolvedInstance.id}_${savedSignup.user_id}_checked_in`,
    event.slug,
    resolvedInstance.id,
    savedSignup.user_id,
    savedSignup.id,
    actor,
    source,
    stringifyJson({ manual: true }),
    now,
    now
  ).run();

  const refreshed = await getSignupByInstanceAndUser(db, event.slug, resolvedInstance.id, savedSignup.user_id);
  return {
    event,
    instance: resolvedInstance,
    signup: refreshed || { ...savedSignup, checked_in_at: now },
    checked_in_at: refreshed?.checked_in_at || now
  };
}

export async function addSignupToEmailList(env, signup, event) {
  if (!signup.email_list_opt_in) {
    return { status: "skipped_opt_out", detail: "Registrant opted out of community email list" };
  }

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return { status: "skipped_not_configured", detail: "RESEND_API_KEY is not configured" };
  }

  const contactBody = {
    email: signup.email,
    first_name: signup.first_name || undefined,
    last_name: signup.last_name || undefined,
    unsubscribed: false
  };

  const created = await resendFetch(env, "/contacts", {
    method: "POST",
    body: JSON.stringify(contactBody)
  });

  let contactStatus = "created";
  if (!created.ok) {
    if (created.status === 409 || created.status === 422) {
      const patched = await resendFetch(env, `/contacts/${encodeURIComponent(signup.email)}`, {
        method: "PATCH",
        body: JSON.stringify({
          first_name: contactBody.first_name,
          last_name: contactBody.last_name
        })
      });
      if (!patched.ok) {
        return { status: "failed", detail: `Resend contact update failed: ${patched.status} ${await safeText(patched)}`.slice(0, 500) };
      }
      contactStatus = "updated";
    } else {
      return { status: "failed", detail: `Resend contact create failed: ${created.status} ${await safeText(created)}`.slice(0, 500) };
    }
  }

  return { status: "synced", detail: `Resend contact ${contactStatus}; event signup stored in HTV_DB` };
}

async function resendFetch(env, path, init) {
  return await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "hack-the-valley-events/1.0",
      ...(init.headers || {})
    }
  });
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function csvEscape(value) {
  const str = value === undefined || value === null ? "" : String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
}

export function signupsToCsv(signups) {
  const columns = [
    "created_at", "updated_at", "event_slug", "event_instance_id", "instance_key", "user_id", "name", "email", "phone", "school", "year",
    "experience", "notes", "email_list_opt_in", "signed_up_at", "checked_in_at", "checked_out_at", "cancelled_at", "metadata_json", "mailing_list_status", "mailing_list_detail"
  ];
  return [
    columns.join(","),
    ...signups.map((row) => columns.map((column) => csvEscape(row[column])).join(","))
  ].join("\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderText(value) {
  return escapeHtml(value || "")
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}

function formatEventDate(value) {
  if (!value) return "Date TBA";
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" }).format(new Date(value));
  } catch {
    return value;
  }
}

export function renderEventPageHtml(event) {
  const signupOpen = event.status === "open";
  const title = escapeHtml(event.title);
  const slug = escapeHtml(event.slug);
  const description = escapeHtml(event.description || "Hack the Valley community event.");
  const content = renderText(event.page_content || event.description || "More event details are coming soon.");
  const image = event.image_url ? `<img class="event-hero-image" src="${escapeHtml(event.image_url)}" alt="${title}">` : "";
  const venue = escapeHtml(event.venue_name || event.venue_address || "Location TBA");
  const when = escapeHtml(formatEventDate(event.starts_at));
  const signupForm = signupOpen ? `
    <form id="signup-form" class="signup-card">
      <h2>Sign up</h2>
      <label>Name <input name="name" required autocomplete="name"></label>
      <label>Email <input name="email" type="email" required autocomplete="email"></label>
      <label class="checkbox"><input name="email_list_opt_in" type="checkbox" checked> Send me Hack the Valley updates</label>
      <button type="submit">Sign up</button>
      <p id="form-message" role="status"></p>
    </form>
    <script>
      document.getElementById("signup-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector("button");
        const message = document.getElementById("form-message");
        button.disabled = true;
        message.textContent = "Submitting…";
        const body = Object.fromEntries(new FormData(form).entries());
        body.email_list_opt_in = new FormData(form).get("email_list_opt_in") === "on";
        body.source = "event-detail-page";
        try {
          const response = await fetch("/api/events/${slug}/signups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Signup failed");
          form.reset();
          button.textContent = "You're signed up";
          message.textContent = "You're on the list.";
        } catch (error) {
          button.disabled = false;
          message.textContent = error.message;
        }
      });
    </script>` : `<div class="signup-card"><h2>Signups are ${escapeHtml(event.status || "closed")}</h2><p>This event is not currently accepting signups.</p></div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Hack the Valley</title>
  <meta name="description" content="${description}">
  <style>
    body{margin:0;background:#0f172a;color:#f8fafc;font-family:Inter,ui-sans-serif,system-ui,sans-serif}a{color:#67e8f9}.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 72px}.nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:48px}.brand{font-weight:900;text-decoration:none;color:#fff}.back{text-decoration:none;color:#94a3b8}.hero{display:grid;gap:28px}.kicker{text-transform:uppercase;letter-spacing:.24em;color:#67e8f9;font-weight:800;font-size:.8rem}h1{font-size:clamp(2.5rem,7vw,5.5rem);line-height:.92;margin:.25em 0}.lede{font-size:1.25rem;color:#cbd5e1;max-width:760px}.event-hero-image{width:100%;max-height:520px;object-fit:cover;border-radius:28px;border:1px solid #334155}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:28px 0}.meta div,.content,.signup-card{background:#111827;border:1px solid #334155;border-radius:22px;padding:22px}.content{font-size:1.08rem;line-height:1.7;color:#dbeafe}.content p{margin:0 0 1em}.signup-card{margin-top:28px;max-width:680px}.signup-card label{display:block;margin:14px 0;color:#cbd5e1}.signup-card input,.signup-card textarea{box-sizing:border-box;width:100%;margin-top:6px;border-radius:12px;border:1px solid #475569;background:#020617;color:#fff;padding:12px}.signup-card .checkbox{display:flex;gap:10px;align-items:center}.signup-card .checkbox input{width:auto}.signup-card button{border:0;border-radius:14px;background:#67e8f9;color:#0f172a;font-weight:900;padding:14px 22px;cursor:pointer}.signup-card button:disabled{opacity:.7;cursor:not-allowed}
  </style>
</head>
<body data-event-detail-page="${slug}">
  <main class="wrap">
    <nav class="nav"><a class="brand" href="/">Hack the Valley</a><a class="back" href="/events">All events</a></nav>
    <section class="hero">
      <div><p class="kicker">Event page</p><h1>${title}</h1><p class="lede">${description}</p></div>
      ${image}
    </section>
    <section class="meta"><div><strong>When</strong><br>${when}</div><div><strong>Where</strong><br>${venue}</div></section>
    <section class="content">${content}</section>
    ${signupForm}
  </main>
</body>
</html>`;
}

export async function handleErrors(fn) {
  try {
    return await fn();
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return jsonResponse({ error: error.message || "Internal server error", errors: error.errors }, { status });
  }
}
