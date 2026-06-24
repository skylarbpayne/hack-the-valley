import {
  parseWithSchema,
  schema,
  stringOrNull
} from "./shared.js";
import { appendAuditEvent, buildAuditEvent } from "./audit.js";
import { generateEventInstanceCandidates } from "../recurrence.js";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPEN_STATUSES = new Set(["draft", "open", "closed", "archived"]);
const INSTANCE_STATUSES = new Set(["draft", "open", "closed", "archived"]);
const EVENT_ADMIN_WRITABLE_FIELDS = [
  "slug",
  "title",
  "description",
  "starts_at",
  "ends_at",
  "venue_name",
  "venue_address",
  "capacity",
  "status",
  "image_url",
  "page_content",
  "signup_fields",
  "signup_fields_json",
  "recurrence_rule",
  "recurrence_rule_json"
];

const NullableString = schema.nullish(schema.string());
const NullableNumber = schema.nullish(schema.number());
const OptionalInteger = schema.optional(schema.pipe(schema.number(), schema.integer(), schema.minValue(1)));

const SignupRoleObjectSchema = schema.object({
  value: schema.optional(schema.string()),
  id: schema.optional(schema.string()),
  key: schema.optional(schema.string()),
  label: schema.optional(schema.string()),
  description: schema.optional(NullableString),
  help: schema.optional(NullableString),
  hint: schema.optional(NullableString)
});

const SignupRoleSchema = schema.union([schema.string(), SignupRoleObjectSchema]);

export const SignupFieldConfigSchema = schema.object({
  roles: schema.optional(schema.array(SignupRoleSchema)),
  signup_roles: schema.optional(schema.array(SignupRoleSchema)),
  default_role: schema.optional(NullableString),
  defaultRole: schema.optional(NullableString),
  label: schema.optional(NullableString),
  role_label: schema.optional(NullableString),
  signup_role_label: schema.optional(NullableString)
});

export const RecurrenceRuleSchema = schema.object({
  frequency: schema.optional(schema.string()),
  interval: OptionalInteger,
  timezone: schema.optional(schema.string()),
  time_zone: schema.optional(schema.string()),
  day_of_week: schema.optional(schema.string()),
  start_time: schema.optional(schema.string()),
  duration_minutes: OptionalInteger,
  starts_on: schema.optional(schema.string()),
  generate_weeks_ahead: OptionalInteger
});

export const EventSeriesSchema = schema.object({
  kind: schema.literal("event_series"),
  slug: schema.string(),
  title: schema.string(),
  description: NullableString,
  starts_at: NullableString,
  ends_at: NullableString,
  venue_name: NullableString,
  venue_address: NullableString,
  capacity: NullableNumber,
  status: schema.picklist(["draft", "open", "closed", "archived"]),
  image_url: NullableString,
  page_content: NullableString,
  signup_fields_json: NullableString,
  recurrence_rule_json: NullableString,
  signup_fields: SignupFieldConfigSchema,
  recurrence_rule: schema.nullish(RecurrenceRuleSchema),
  instance_count: schema.optional(schema.number()),
  active_instance_id: NullableString,
  active_instance_key: NullableString,
  created_at: NullableString,
  updated_at: NullableString
});

export const EventInstanceSchema = schema.object({
  kind: schema.literal("event_instance"),
  id: schema.string(),
  event_slug: schema.string(),
  instance_key: schema.string(),
  title: NullableString,
  starts_at: NullableString,
  ends_at: NullableString,
  venue_name: NullableString,
  venue_address: NullableString,
  capacity: NullableNumber,
  status: schema.picklist(["draft", "open", "closed", "archived"]),
  metadata_json: NullableString,
  metadata: schema.record(schema.string(), schema.unknown()),
  created_at: NullableString,
  updated_at: NullableString
});

export function toEventSeries(row = {}) {
  const signupFields = parseSignupFieldConfig(row);
  const recurrenceRule = parseOptionalJsonObject(row.recurrence_rule ?? row.recurrence_rule_json, "recurrence_rule_json", null);
  const parsedRecurrenceRule = recurrenceRule === null ? null : parseWithSchema(RecurrenceRuleSchema, recurrenceRule);
  const dto = {
    kind: "event_series",
    slug: stringOrNull(row.slug) || "",
    title: stringOrNull(row.title) || "",
    description: stringOrNull(row.description),
    starts_at: stringOrNull(row.starts_at),
    ends_at: stringOrNull(row.ends_at),
    venue_name: stringOrNull(row.venue_name),
    venue_address: stringOrNull(row.venue_address),
    capacity: numberOrNull(row.capacity),
    status: normalizeStatus(row.status),
    image_url: stringOrNull(row.image_url),
    page_content: stringOrNull(row.page_content),
    signup_fields_json: stringOrNull(row.signup_fields_json),
    recurrence_rule_json: stringOrNull(row.recurrence_rule_json),
    signup_fields: signupFields,
    recurrence_rule: parsedRecurrenceRule,
    instance_count: numberOrZero(row.instance_count),
    active_instance_id: stringOrNull(row.active_instance_id),
    active_instance_key: stringOrNull(row.active_instance_key),
    created_at: stringOrNull(row.created_at),
    updated_at: stringOrNull(row.updated_at)
  };
  return parseWithSchema(EventSeriesSchema, dto);
}

export function toEventInstance(row = {}) {
  const metadata = parseOptionalJsonObject(row.metadata ?? row.metadata_json, "metadata_json", {});
  const dto = {
    kind: "event_instance",
    id: stringOrNull(row.id) || "",
    event_slug: stringOrNull(row.event_slug) || "",
    instance_key: stringOrNull(row.instance_key) || "",
    title: stringOrNull(row.title),
    starts_at: stringOrNull(row.starts_at),
    ends_at: stringOrNull(row.ends_at),
    venue_name: stringOrNull(row.venue_name),
    venue_address: stringOrNull(row.venue_address),
    capacity: numberOrNull(row.capacity),
    status: normalizeInstanceStatus(row.status),
    metadata_json: stringOrNull(row.metadata_json),
    metadata,
    created_at: stringOrNull(row.created_at),
    updated_at: stringOrNull(row.updated_at)
  };
  return parseWithSchema(EventInstanceSchema, dto);
}

export function parseSignupFieldConfig(event = {}) {
  const rawConfig = parseOptionalJsonObject(event.signup_fields ?? event.signup_fields_json, "signup_fields_json", {});
  const config = parseWithSchema(SignupFieldConfigSchema, rawConfig);
  const rawRoles = Array.isArray(config.roles)
    ? config.roles
    : Array.isArray(config.signup_roles)
      ? config.signup_roles
      : [];
  const roles = rawRoles
    .map((role) => {
      const source = role && typeof role === "object" ? role : { value: role, label: role };
      const value = normalizeSignupRoleValue(source.value || source.id || source.key || source.label);
      if (!value) return null;
      return {
        value,
        label: stringOrNull(source.label) || titleize(value),
        description: stringOrNull(source.description || source.help || source.hint)
      };
    })
    .filter(Boolean);
  const requestedDefault = normalizeSignupRoleValue(config.default_role || config.defaultRole);
  return parseWithSchema(SignupFieldConfigSchema, {
    roles,
    default_role: roles.find((role) => role.value === requestedDefault)?.value || roles[0]?.value || null,
    label: stringOrNull(config.role_label || config.signup_role_label) || "How do you want to participate?",
    role_label: stringOrNull(config.role_label || config.signup_role_label) || "How do you want to participate?"
  });
}

export function normalizeEventSeriesInput(input = {}, existing = {}) {
  const title = String(input.title ?? existing.title ?? "").trim();
  const explicitSlug = input.slug !== undefined && input.slug !== null && String(input.slug).trim() !== "";
  const slug = explicitSlug ? String(input.slug).trim() : slugify(title || existing.slug);
  const status = String(input.status ?? existing.status ?? "draft").trim().toLowerCase();
  const signupFields = normalizeJsonObjectForStorage(
    input.signup_fields ?? input.signup_fields_json ?? existing.signup_fields_json ?? null,
    "signup_fields_json",
    SignupFieldConfigSchema
  );
  const recurrenceRule = normalizeJsonObjectForStorage(
    input.recurrence_rule ?? input.recurrence_rule_json ?? existing.recurrence_rule_json ?? null,
    "recurrence_rule_json",
    RecurrenceRuleSchema
  );

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
    signup_fields_json: signupFields.json,
    recurrence_rule_json: recurrenceRule.json
  };

  const errors = [...signupFields.errors, ...recurrenceRule.errors];
  if (!event.title) errors.push("title is required");
  if (!event.slug || !SLUG_RE.test(event.slug)) errors.push("slug must use lowercase letters, numbers, and hyphens");
  if (!OPEN_STATUSES.has(event.status)) errors.push("status must be draft, open, closed, or archived");
  if (event.capacity !== null && event.capacity !== "" && (!Number.isInteger(Number(event.capacity)) || Number(event.capacity) < 1)) {
    errors.push("capacity must be a positive integer when provided");
  }
  event.capacity = event.capacity === null || event.capacity === "" ? null : Number(event.capacity);

  return { event, errors };
}

export function normalizeEventInstanceInput(input = {}, eventSeries = {}) {
  const instanceKey = trimOrNull(input.instance_key ?? input.instanceKey) || instanceKeyFromStartsAt(input.starts_at ?? eventSeries.starts_at);
  const instance = {
    id: trimOrNull(input.id) || instanceIdFor(eventSeries.slug, instanceKey),
    event_slug: trimOrNull(input.event_slug ?? input.eventSlug) || trimOrNull(eventSeries.slug),
    instance_key: instanceKey,
    title: trimOrNull(input.title ?? eventSeries.title),
    starts_at: trimOrNull(input.starts_at ?? eventSeries.starts_at),
    ends_at: trimOrNull(input.ends_at ?? eventSeries.ends_at),
    venue_name: trimOrNull(input.venue_name ?? eventSeries.venue_name),
    venue_address: trimOrNull(input.venue_address ?? eventSeries.venue_address),
    capacity: input.capacity ?? eventSeries.capacity ?? null,
    status: String(input.status ?? eventSeries.status ?? "draft").trim().toLowerCase(),
    metadata_json: stringifyJson(input.metadata ?? input.metadata_json ?? null)
  };
  const errors = [];
  if (!instance.event_slug) errors.push("event_slug is required");
  if (!instance.instance_key) errors.push("instance_key is required");
  if (!INSTANCE_STATUSES.has(instance.status)) errors.push("status must be draft, open, closed, or archived");
  if (instance.capacity !== null && instance.capacity !== "" && (!Number.isInteger(Number(instance.capacity)) || Number(instance.capacity) < 1)) {
    errors.push("capacity must be a positive integer when provided");
  }
  instance.capacity = instance.capacity === null || instance.capacity === "" ? numberOrNull(eventSeries.capacity) : Number(instance.capacity);
  return { instance, errors };
}

export async function listEventSeries(db, { includeArchived = false, includeInstances = true } = {}) {
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
  const events = (result.results || []).map(toEventSeries);
  if (!includeInstances) return events;
  return await Promise.all(events.map(async (event) => ({
    ...event,
    instances: await listEventInstances(db, event.slug)
  })));
}

export async function getEventSeries(db, slug) {
  const row = await db.prepare(`
    SELECT
      events.*,
      (SELECT COUNT(*) FROM event_instances ei WHERE ei.event_slug = events.slug) AS instance_count,
      (SELECT ei.id FROM event_instances ei WHERE ei.event_slug = events.slug AND ei.status = 'open' ORDER BY ei.starts_at IS NULL, ei.starts_at ASC, ei.created_at ASC LIMIT 1) AS active_instance_id,
      (SELECT ei.instance_key FROM event_instances ei WHERE ei.event_slug = events.slug AND ei.status = 'open' ORDER BY ei.starts_at IS NULL, ei.starts_at ASC, ei.created_at ASC LIMIT 1) AS active_instance_key
    FROM events
    WHERE slug = ?
  `).bind(slug).first();
  return row ? toEventSeries(row) : null;
}

export async function createEventSeriesFromAdminRoute(db, { input = {}, access = {}, now = new Date().toISOString() } = {}) {
  return await upsertEventSeries(db, eventAdminWritableInput(input), {}, {
    now,
    provenance: trustedEventAdminProvenance(access),
    route: "events.index.post"
  });
}

export async function updateEventSeriesFromAdminRoute(db, { slug, input = {}, access = {}, now = new Date().toISOString() } = {}) {
  const existing = await getEventSeries(db, slug);
  if (!existing) throw Object.assign(new Error("Event not found"), { status: 404 });
  return await upsertEventSeries(db, { ...eventAdminWritableInput(input), slug: existing.slug }, existing, {
    now,
    provenance: trustedEventAdminProvenance(access),
    route: "events.slug.patch"
  });
}

export async function upsertEventSeries(db, input, existing = {}, { now = new Date().toISOString(), provenance = null, route = null } = {}) {
  const { event, errors } = normalizeEventSeriesInput(input, existing);
  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

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

  const savedEvent = await getEventSeries(db, event.slug);
  await upsertEventInstance(db, savedEvent, { now });
  await appendEventAdminAudit(db, {
    action: existing?.slug ? "event.update" : "event.create",
    event: savedEvent,
    provenance,
    route,
    now
  });
  return savedEvent;
}

export async function upsertEventInstance(db, event, { now = new Date().toISOString() } = {}) {
  const instanceKey = instanceKeyFromStartsAt(event.starts_at);
  const instanceId = instanceIdFor(event.slug, instanceKey);
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

export function trustedEventAdminProvenance(access = {}) {
  return {
    source: access.bootstrap ? "bootstrap_admin" : "admin",
    actorUserId: stringOrNull(access.user?.id ?? access.actorUserId ?? access.actor_user_id),
    role: stringOrNull(access.role?.role ?? access.role),
    scopeType: stringOrNull(access.role?.scope_type ?? access.scopeType ?? access.scope_type),
    scopeId: stringOrNull(access.role?.scope_id ?? access.scopeId ?? access.scope_id),
    bootstrap: Boolean(access.bootstrap)
  };
}

export function prepareEventImageUploadFromAdminRoute({
  slug,
  filename = "event-image",
  contentType,
  contentLength = 0,
  maxBytes,
  id,
  now = new Date()
} = {}) {
  const eventSlug = stringOrNull(slug);
  if (!eventSlug || !SLUG_RE.test(eventSlug)) {
    throw Object.assign(new Error("Valid event slug required."), { status: 400 });
  }
  const type = String(contentType || "").toLowerCase();
  if (!type.startsWith("image/")) {
    throw Object.assign(new Error("Event image must be an image file."), { status: 400 });
  }
  const size = Number(contentLength || 0);
  const limit = Number(maxBytes || 0);
  if (size && limit && size > limit) {
    throw Object.assign(new Error(`Event image is too large. Limit is ${Math.round(limit / 1024 / 1024)}MB.`), { status: 400 });
  }

  const uploadedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const safeFilename = stringOrNull(filename) || "event-image";
  const randomPart = stringOrNull(id) || `img_${uploadedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const key = `event-images/${eventSlug}/${uploadedAt.replace(/[:.]/g, "-")}-${randomPart}-${safeFilename}`;
  return {
    slug: eventSlug,
    contentType: type,
    key,
    imageUrl: `/api/events/${encodeURIComponent(eventSlug)}/image?key=${encodeURIComponent(key)}`,
    metadata: {
      originalFilename: safeFilename,
      kind: "event-image",
      eventSlug,
      uploadedAt
    }
  };
}

export function assertEventImageKeyForRoute(slug, key) {
  const eventSlug = stringOrNull(slug);
  if (!eventSlug || !SLUG_RE.test(eventSlug)) {
    throw Object.assign(new Error("Valid event slug required."), { status: 400 });
  }
  const prefix = `event-images/${eventSlug}/`;
  if (!key || !String(key).startsWith(prefix)) {
    throw Object.assign(new Error("Valid event image key required."), { status: 400 });
  }
}

export async function listEventInstances(db, eventSlug, _options = {}) {
  const result = await db.prepare(`
    SELECT *
    FROM event_instances
    WHERE event_slug = ?
    ORDER BY starts_at IS NULL, starts_at ASC, created_at ASC
  `).bind(eventSlug).all();
  return (result.results || []).map(toEventInstance);
}

export async function resolveOpenEventInstance(db, eventSlug) {
  const row = await db.prepare(`
    SELECT *
    FROM event_instances
    WHERE event_slug = ? AND status = 'open'
    ORDER BY starts_at IS NULL, starts_at ASC, created_at ASC
    LIMIT 1
  `).bind(eventSlug).first();
  return row ? toEventInstance(row) : null;
}

export function previewGeneratedInstances(eventSeries, options = {}) {
  const series = toEventSeries(eventSeries);
  const candidates = generateEventInstanceCandidates(series, { ...options, dryRun: true });
  const instances = candidates.map(toEventInstance);
  return {
    event_slug: series.slug,
    applied: false,
    candidates: instances,
    instances
  };
}

function eventAdminWritableInput(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const safe = {};
  for (const field of EVENT_ADMIN_WRITABLE_FIELDS) {
    if (Object.hasOwn(source, field)) safe[field] = source[field];
  }
  return safe;
}

async function appendEventAdminAudit(db, { action, event, provenance, route, now } = {}) {
  if (!provenance) return null;
  return await appendAuditEvent(db, buildAuditEvent({
    action,
    actorUserId: provenance.actorUserId,
    targetType: "event",
    targetId: event?.slug,
    metadata: {
      source: provenance.source,
      role: provenance.role,
      scopeType: provenance.scopeType,
      scopeId: provenance.scopeId,
      bootstrap: provenance.bootstrap,
      route,
      title: event?.title || null
    },
    createdAt: now
  }));
}

function parseOptionalJsonObject(value, fieldName, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") {
    throw validationBoundaryError(`${fieldName} must be a JSON object`, [{ path: fieldName, message: "Expected a JSON object" }]);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw validationBoundaryError(`${fieldName} must be valid JSON`, [{ path: fieldName, message: "Expected valid JSON" }]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw validationBoundaryError(`${fieldName} must be a JSON object`, [{ path: fieldName, message: "Expected a JSON object" }]);
  }
  return parsed;
}

function normalizeJsonObjectForStorage(value, fieldName, schemaDefinition) {
  if (value === undefined || value === null || value === "") return { json: null, errors: [] };
  let parsed;
  let json;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { json: null, errors: [`${fieldName} must be valid JSON`] };
    }
    json = value;
  } else if (typeof value === "object" && !Array.isArray(value)) {
    parsed = value;
    json = JSON.stringify(value);
  } else {
    return { json: null, errors: [`${fieldName} must be a JSON object`] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { json: null, errors: [`${fieldName} must be a JSON object`] };
  }

  try {
    parseWithSchema(schemaDefinition, parsed);
  } catch (error) {
    return { json: null, errors: validationMessages(error, fieldName) };
  }

  return { json, errors: [] };
}

function validationMessages(error, fieldName) {
  if (!Array.isArray(error?.errors) || error.errors.length === 0) return [`${fieldName} is invalid`];
  return error.errors.map((issue) => {
    const path = String(issue.path || "").trim();
    const prefix = path && path !== fieldName ? `${fieldName}.${path}` : fieldName;
    return `${prefix}: ${issue.message || "Invalid value"}`;
  });
}

function validationBoundaryError(message, errors) {
  return Object.assign(new Error(message), {
    status: 400,
    ok: false,
    code: "validation_error",
    error: message,
    errors
  });
}

function normalizeStatus(value) {
  const status = String(value || "draft").trim().toLowerCase();
  return OPEN_STATUSES.has(status) ? status : status;
}

function normalizeInstanceStatus(value) {
  const status = String(value || "draft").trim().toLowerCase();
  return INSTANCE_STATUSES.has(status) ? status : status;
}

function normalizeSignupRoleValue(value) {
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

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function instanceKeyFromStartsAt(value) {
  if (!value) return "unscheduled";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return slugify(value) || "unscheduled";
  return parsed.toISOString().slice(0, 10);
}

function instanceIdFor(eventSlug, instanceKey) {
  return `inst_${String(eventSlug || "event").replaceAll("-", "_")}_${String(instanceKey || "unscheduled").replaceAll("-", "_")}`;
}
