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
  const db = env.HTV_DB || env.DB;
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
    signup_fields_json: stringifyJson(input.signup_fields ?? input.signup_fields_json ?? existing.signup_fields_json ?? null)
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
  const sql = includeArchived
    ? "SELECT * FROM events ORDER BY COALESCE(starts_at, created_at) DESC"
    : "SELECT * FROM events WHERE status != 'archived' ORDER BY COALESCE(starts_at, created_at) DESC";
  const result = await db.prepare(sql).all();
  return result.results || [];
}

export async function getEvent(db, slug) {
  return await db.prepare("SELECT * FROM events WHERE slug = ?").bind(slug).first();
}

export async function upsertEvent(db, input, existing = {}) {
  const { event, errors } = normalizeEventInput(input, existing);
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO events (slug, title, description, starts_at, ends_at, venue_name, venue_address, capacity, status, signup_fields_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      venue_name = excluded.venue_name,
      venue_address = excluded.venue_address,
      capacity = excluded.capacity,
      status = excluded.status,
      signup_fields_json = excluded.signup_fields_json,
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
    event.signup_fields_json,
    now,
    now
  ).run();

  return await getEvent(db, event.slug);
}

export async function listSignups(db, eventSlug) {
  const result = await db.prepare(`
    SELECT * FROM signups
    WHERE event_slug = ?
    ORDER BY created_at ASC
  `).bind(eventSlug).all();
  return result.results || [];
}

export async function upsertSignup(db, eventSlug, input, mailingListResult) {
  const { signup, errors } = normalizeSignupInput(input, eventSlug);
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO signups (
      event_slug, email, name, first_name, last_name, phone, school, year, experience, notes,
      email_list_opt_in, metadata_json, mailing_list_status, mailing_list_detail, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_slug, email) DO UPDATE SET
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
    signup.event_slug,
    signup.email,
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

  return await db.prepare("SELECT * FROM signups WHERE event_slug = ? AND email = ?")
    .bind(signup.event_slug, signup.email)
    .first();
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
    "created_at", "updated_at", "event_slug", "name", "email", "phone", "school", "year",
    "experience", "notes", "email_list_opt_in", "mailing_list_status", "mailing_list_detail"
  ];
  return [
    columns.join(","),
    ...signups.map((row) => columns.map((column) => csvEscape(row[column])).join(","))
  ].join("\n");
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
