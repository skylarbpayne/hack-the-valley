import {
  parseJsonObject,
  stringOrNull
} from "./shared.js";

const RESOURCE_STATUSES = new Set(["available", "checked_out", "maintenance", "retired", "lost"]);
const RESOURCE_CONDITIONS = new Set(["new", "good", "fair", "needs_repair", "retired", "lost", "unknown"]);
const PHYSICAL_RESOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{5,95}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function toPhysicalResource(row = {}) {
  if (!row) return null;
  const currentCheckout = row.checkout_id ? {
    id: stringOrNull(row.checkout_id),
    resourceId: stringOrNull(row.id ?? row.resource_id),
    holderUserId: stringOrNull(row.holder_user_id),
    holderName: stringOrNull(row.holder_name),
    holderEmail: stringOrNull(row.holder_email),
    holderDisplayName: stringOrNull(row.holder_display_name),
    holderDisplayEmail: stringOrNull(row.holder_display_email),
    checkedOutAt: stringOrNull(row.checked_out_at),
    dueAt: stringOrNull(row.due_at),
    checkedOutByUserId: stringOrNull(row.checked_out_by_user_id),
    notes: stringOrNull(row.checkout_notes)
  } : null;

  return {
    id: stringOrNull(row.id),
    name: stringOrNull(row.name),
    category: stringOrNull(row.category),
    inventoryCode: stringOrNull(row.inventory_code),
    assetTag: stringOrNull(row.asset_tag),
    serialNumber: stringOrNull(row.serial_number),
    description: stringOrNull(row.description),
    location: stringOrNull(row.location),
    condition: stringOrNull(row.condition) || "unknown",
    status: stringOrNull(row.status) || "available",
    notes: stringOrNull(row.notes),
    photoStorageKey: stringOrNull(row.photo_storage_key),
    photoUrl: stringOrNull(row.photo_url),
    photoOriginalFilename: stringOrNull(row.photo_original_filename),
    photoContentType: stringOrNull(row.photo_content_type),
    photoBytes: row.photo_bytes == null ? null : Number(row.photo_bytes),
    photoUploadedAt: stringOrNull(row.photo_uploaded_at),
    photoUploadedByUserId: stringOrNull(row.photo_uploaded_by_user_id),
    metadata: parseJsonObject(row.metadata_json, {}),
    createdAt: stringOrNull(row.created_at),
    updatedAt: stringOrNull(row.updated_at),
    createdByUserId: stringOrNull(row.created_by_user_id),
    updatedByUserId: stringOrNull(row.updated_by_user_id),
    stableUrlPath: row.id ? physicalResourceStableUrlPath(row.id) : null,
    currentCheckout
  };
}

export function toPhysicalResourceCheckout(row = {}) {
  if (!row) return null;
  return {
    id: stringOrNull(row.id),
    resourceId: stringOrNull(row.resource_id),
    holderUserId: stringOrNull(row.holder_user_id),
    holderName: stringOrNull(row.holder_name),
    holderEmail: stringOrNull(row.holder_email),
    holderDisplayName: stringOrNull(row.holder_display_name),
    holderDisplayEmail: stringOrNull(row.holder_display_email),
    checkedOutAt: stringOrNull(row.checked_out_at),
    dueAt: stringOrNull(row.due_at),
    returnedAt: stringOrNull(row.returned_at),
    checkedOutByUserId: stringOrNull(row.checked_out_by_user_id),
    returnedByUserId: stringOrNull(row.returned_by_user_id),
    notes: stringOrNull(row.notes),
    returnNotes: stringOrNull(row.return_notes),
    createdAt: stringOrNull(row.created_at),
    updatedAt: stringOrNull(row.updated_at),
    active: !row.returned_at
  };
}

export function normalizePhysicalResourceInput(input = {}, existing = {}) {
  const merged = { ...existing, ...input };
  const resource = {
    name: stringOrNull(merged.name),
    category: stringOrNull(merged.category),
    inventory_code: stringOrNull(merged.inventory_code ?? merged.inventoryCode),
    asset_tag: stringOrNull(merged.asset_tag ?? merged.assetTag),
    serial_number: stringOrNull(merged.serial_number ?? merged.serialNumber),
    description: stringOrNull(merged.description),
    location: stringOrNull(merged.location),
    condition: normalizeCondition(merged.condition ?? "good"),
    status: normalizeStatus(merged.status ?? "available"),
    notes: stringOrNull(merged.notes),
    metadata_json: stringifyMetadata(merged.metadata ?? merged.metadata_json)
  };

  const errors = [];
  if (!resource.name) errors.push("name is required");
  if (!RESOURCE_CONDITIONS.has(resource.condition)) errors.push("condition must be new, good, fair, needs_repair, retired, lost, or unknown");
  if (!RESOURCE_STATUSES.has(resource.status)) errors.push("status must be available, checked_out, maintenance, retired, or lost");
  if (resource.inventory_code && resource.inventory_code.length > 80) errors.push("inventory code must be 80 characters or fewer");
  if (resource.asset_tag && resource.asset_tag.length > 120) errors.push("asset tag must be 120 characters or fewer");
  if (resource.serial_number && resource.serial_number.length > 180) errors.push("serial number must be 180 characters or fewer");

  if (errors.length) throw validationError(errors);
  return resource;
}

export function normalizePhysicalResourcePatch(input = {}, existing = {}) {
  const patchable = ["name", "category", "inventory_code", "inventoryCode", "asset_tag", "assetTag", "serial_number", "serialNumber", "description", "location", "condition", "status", "notes", "metadata", "metadata_json"];
  const supplied = {};
  for (const key of patchable) {
    if (Object.prototype.hasOwnProperty.call(input, key)) supplied[key] = input[key];
  }
  return normalizePhysicalResourceInput(supplied, existing);
}

export function normalizeCheckoutInput(input = {}) {
  const checkout = {
    holder_user_id: stringOrNull(input.holder_user_id ?? input.holderUserId),
    holder_name: stringOrNull(input.holder_name ?? input.holderName),
    holder_email: normalizeEmail(input.holder_email ?? input.holderEmail),
    due_at: normalizeIsoOrNull(input.due_at ?? input.dueAt),
    notes: stringOrNull(input.notes)
  };
  const errors = [];
  if (!checkout.holder_user_id && !checkout.holder_name && !checkout.holder_email) {
    errors.push("holder user, holder name, or holder email is required");
  }
  if (checkout.holder_email && !EMAIL_RE.test(checkout.holder_email)) errors.push("holder email must be valid");
  if (errors.length) throw validationError(errors);
  return checkout;
}

export function normalizeReturnInput(input = {}) {
  const status = input.resource_status ?? input.resourceStatus ?? "available";
  const normalizedStatus = normalizeStatus(status);
  const errors = [];
  if (!RESOURCE_STATUSES.has(normalizedStatus) || normalizedStatus === "checked_out") {
    errors.push("resource status after return must be available, maintenance, retired, or lost");
  }
  if (errors.length) throw validationError(errors);
  return {
    resource_status: normalizedStatus,
    return_notes: stringOrNull(input.return_notes ?? input.returnNotes)
  };
}

export async function listPhysicalResources(db, { status = null, query = null, includeRetired = false, limit = 100 } = {}) {
  const where = [];
  const binds = [];
  const normalizedStatus = stringOrNull(status);
  if (normalizedStatus) {
    where.push("r.status = ?");
    binds.push(normalizedStatus);
  } else if (!includeRetired) {
    where.push("r.status != 'retired'");
  }
  const q = stringOrNull(query);
  if (q) {
    where.push("(lower(r.name) LIKE ? OR lower(COALESCE(r.inventory_code, '')) LIKE ? OR lower(COALESCE(r.asset_tag, '')) LIKE ? OR lower(COALESCE(r.serial_number, '')) LIKE ? OR lower(COALESCE(r.category, '')) LIKE ?)");
    const like = `%${q.toLowerCase()}%`;
    binds.push(like, like, like, like, like);
  }
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  binds.push(safeLimit);
  const result = await db.prepare(`
    SELECT
      r.*,
      c.id AS checkout_id,
      c.holder_user_id,
      c.holder_name,
      c.holder_email,
      COALESCE(hu.name, c.holder_name) AS holder_display_name,
      COALESCE(hu.email, c.holder_email) AS holder_display_email,
      c.checked_out_at,
      c.due_at,
      c.checked_out_by_user_id,
      c.notes AS checkout_notes
    FROM physical_resources r
    LEFT JOIN physical_resource_checkouts c ON c.resource_id = r.id AND c.returned_at IS NULL
    LEFT JOIN users hu ON hu.id = c.holder_user_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY lower(r.category) ASC, lower(r.name) ASC, r.created_at DESC
    LIMIT ?
  `).bind(...binds).all();
  return (result.results || []).map(toPhysicalResource);
}

export async function getPhysicalResource(db, id) {
  const row = await db.prepare(`
    SELECT
      r.*,
      c.id AS checkout_id,
      c.holder_user_id,
      c.holder_name,
      c.holder_email,
      COALESCE(hu.name, c.holder_name) AS holder_display_name,
      COALESCE(hu.email, c.holder_email) AS holder_display_email,
      c.checked_out_at,
      c.due_at,
      c.checked_out_by_user_id,
      c.notes AS checkout_notes
    FROM physical_resources r
    LEFT JOIN physical_resource_checkouts c ON c.resource_id = r.id AND c.returned_at IS NULL
    LEFT JOIN users hu ON hu.id = c.holder_user_id
    WHERE r.id = ?
    LIMIT 1
  `).bind(id).first();
  return toPhysicalResource(row);
}

export async function createPhysicalResource(db, input, { actorUserId = null } = {}) {
  const requestedId = normalizePhysicalResourceId(input?.id ?? input?.resource_id ?? input?.resourceId);
  const resource = normalizePhysicalResourceInput(input);
  if (resource.status === "checked_out") {
    throw validationError("Use the checkout endpoint to mark a resource checked out so assignment history is recorded.");
  }
  const now = new Date().toISOString();
  const id = requestedId || generatePhysicalResourceId();
  if (requestedId) {
    const existing = await getPhysicalResource(db, requestedId);
    if (existing) return existing;
  }
  await db.prepare(`
    INSERT INTO physical_resources (
      id, name, category, inventory_code, asset_tag, serial_number, description, location, condition, status,
      notes, metadata_json, created_at, updated_at, created_by_user_id, updated_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    resource.name,
    resource.category,
    resource.inventory_code || generatedInventoryCode(id),
    resource.asset_tag,
    resource.serial_number,
    resource.description,
    resource.location,
    resource.condition,
    resource.status,
    resource.notes,
    resource.metadata_json,
    now,
    now,
    actorUserId,
    actorUserId
  ).run();
  return await getPhysicalResource(db, id);
}

export async function updatePhysicalResource(db, id, input, { actorUserId = null } = {}) {
  const existing = await requirePhysicalResource(db, id);
  const resource = normalizePhysicalResourcePatch(input, rowFromPhysicalResource(existing));
  const activeCheckout = await getActiveCheckout(db, id);
  if (resource.status === "checked_out" && !activeCheckout) {
    throw validationError("Use the checkout endpoint to mark a resource checked out so assignment history is recorded.");
  }
  if (activeCheckout && resource.status !== "checked_out") {
    throw Object.assign(new Error("Return the active checkout before changing this resource status."), { status: 409 });
  }
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE physical_resources
    SET name = ?, category = ?, inventory_code = ?, asset_tag = ?, serial_number = ?, description = ?, location = ?, condition = ?, status = ?, notes = ?, metadata_json = ?, updated_at = ?, updated_by_user_id = ?
    WHERE id = ?
  `).bind(
    resource.name,
    resource.category,
    resource.inventory_code || existing.inventoryCode || generatedInventoryCode(id),
    resource.asset_tag,
    resource.serial_number,
    resource.description,
    resource.location,
    resource.condition,
    resource.status,
    resource.notes,
    resource.metadata_json,
    now,
    actorUserId,
    id
  ).run();
  return await getPhysicalResource(db, id);
}

export async function retirePhysicalResource(db, id, { actorUserId = null, notes = null } = {}) {
  await requirePhysicalResource(db, id);
  const active = await getActiveCheckout(db, id);
  if (active) throw Object.assign(new Error("Return the active checkout before retiring this resource."), { status: 409 });
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE physical_resources
    SET status = 'retired', updated_at = ?, updated_by_user_id = ?, notes = COALESCE(?, notes)
    WHERE id = ?
  `).bind(now, actorUserId, stringOrNull(notes), id).run();
  return await getPhysicalResource(db, id);
}

export async function listPhysicalResourceCheckouts(db, resourceId, { limit = 50 } = {}) {
  await requirePhysicalResource(db, resourceId);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const result = await db.prepare(`
    SELECT
      c.*,
      COALESCE(hu.name, c.holder_name) AS holder_display_name,
      COALESCE(hu.email, c.holder_email) AS holder_display_email
    FROM physical_resource_checkouts c
    LEFT JOIN users hu ON hu.id = c.holder_user_id
    WHERE c.resource_id = ?
    ORDER BY c.checked_out_at DESC, c.created_at DESC
    LIMIT ?
  `).bind(resourceId, safeLimit).all();
  return (result.results || []).map(toPhysicalResourceCheckout);
}

export async function checkoutPhysicalResource(db, resourceId, input, { actorUserId = null } = {}) {
  const resource = await requirePhysicalResource(db, resourceId);
  const active = await getActiveCheckout(db, resourceId);
  if (active) throw Object.assign(new Error("Resource is already checked out."), { status: 409 });
  if (resource.status !== "available") {
    throw Object.assign(new Error("Only available resources can be checked out."), { status: 409 });
  }
  const checkout = normalizeCheckoutInput(input);
  const now = new Date().toISOString();
  const id = generateId("pco");
  await db.prepare(`
    INSERT INTO physical_resource_checkouts (
      id, resource_id, holder_user_id, holder_name, holder_email, checked_out_at, due_at,
      checked_out_by_user_id, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    resourceId,
    checkout.holder_user_id,
    checkout.holder_name,
    checkout.holder_email,
    now,
    checkout.due_at,
    actorUserId,
    checkout.notes,
    now,
    now
  ).run();
  await db.prepare("UPDATE physical_resources SET status = 'checked_out', updated_at = ?, updated_by_user_id = ? WHERE id = ?")
    .bind(now, actorUserId, resourceId)
    .run();
  return {
    resource: await getPhysicalResource(db, resourceId),
    checkout: toPhysicalResourceCheckout(await getCheckoutById(db, id))
  };
}

export async function returnPhysicalResource(db, resourceId, input, { actorUserId = null } = {}) {
  await requirePhysicalResource(db, resourceId);
  const active = await getActiveCheckout(db, resourceId);
  if (!active) throw Object.assign(new Error("Resource does not have an active checkout."), { status: 409 });
  const normalized = normalizeReturnInput(input);
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE physical_resource_checkouts
    SET returned_at = ?, returned_by_user_id = ?, return_notes = ?, updated_at = ?
    WHERE id = ? AND returned_at IS NULL
  `).bind(now, actorUserId, normalized.return_notes, now, active.id).run();
  await db.prepare("UPDATE physical_resources SET status = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ?")
    .bind(normalized.resource_status, now, actorUserId, resourceId)
    .run();
  return {
    resource: await getPhysicalResource(db, resourceId),
    checkout: toPhysicalResourceCheckout(await getCheckoutById(db, active.id))
  };
}

export function validatePhysicalResourcePhotoUpload({ filename = "resource-photo", contentType = "", contentLength = 0, maxBytes = 25 * 1024 * 1024, id = null } = {}) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  const errors = [];
  if (!allowed.has(type)) errors.push("Resource photos must be jpeg, png, webp, or gif.");
  const bytes = Number(contentLength || 0);
  if (bytes && bytes > maxBytes) errors.push(`Photo is too large. Limit is ${Math.round(maxBytes / 1024 / 1024)}MB.`);
  const safeFilename = sanitizePhotoFilename(filename);
  const extension = extensionForContentType(type) || extensionFromFilename(safeFilename);
  if (!extension) errors.push("Photo filename must have a supported image extension.");
  if (errors.length) return { ok: false, error: "Upload rejected.", errors };
  const uploadId = id || generateId("rpho");
  return {
    ok: true,
    id: uploadId,
    key: `physical-resources/${uploadId}.${extension}`,
    safeFilename,
    contentType: type,
    bytes
  };
}

export async function attachPhysicalResourcePhoto(db, resourceId, upload, { actorUserId = null } = {}) {
  await requirePhysicalResource(db, resourceId);
  const now = new Date().toISOString();
  const photoUrl = `/api/admin/physical-resources/${encodeURIComponent(resourceId)}/photo`;
  await db.prepare(`
    UPDATE physical_resources
    SET photo_storage_key = ?, photo_url = ?, photo_original_filename = ?, photo_content_type = ?, photo_bytes = ?,
        photo_uploaded_at = ?, photo_uploaded_by_user_id = ?, updated_at = ?, updated_by_user_id = ?
    WHERE id = ?
  `).bind(
    upload.key,
    photoUrl,
    upload.safeFilename,
    upload.contentType,
    upload.bytes || null,
    now,
    actorUserId,
    now,
    actorUserId,
    resourceId
  ).run();
  return await getPhysicalResource(db, resourceId);
}

function extensionForContentType(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return null;
}

function extensionFromFilename(filename) {
  const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = match?.[1];
  return ["jpg", "jpeg", "png", "webp", "gif"].includes(ext) ? (ext === "jpeg" ? "jpg" : ext) : null;
}

function sanitizePhotoFilename(value) {
  const base = String(value || "resource-photo")
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return base || "resource-photo";
}

function generatedInventoryCode(id) {
  return String(id || generatePhysicalResourceId()).replace(/^pres_/, "HTV-").slice(0, 80);
}

export function normalizePhysicalResourceId(value) {
  const id = stringOrNull(value)?.toLowerCase();
  if (!id) return null;
  if (!PHYSICAL_RESOURCE_ID_RE.test(id)) {
    throw validationError("Physical resource id must be a URL-safe id 6-96 characters long using letters, numbers, underscores, or hyphens.");
  }
  return id;
}

export function generatePhysicalResourceId() {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) {
    return `pres_${cryptoObject.randomUUID().replaceAll("-", "")}`;
  }
  const bytes = new Uint8Array(16);
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `pres_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function physicalResourceStableUrlPath(id) {
  const normalizedId = normalizePhysicalResourceId(id);
  return `/resources/${encodeURIComponent(normalizedId)}`;
}

async function requirePhysicalResource(db, id) {
  const resource = await getPhysicalResource(db, id);
  if (!resource) throw Object.assign(new Error("Physical resource not found."), { status: 404 });
  return resource;
}

async function getActiveCheckout(db, resourceId) {
  return await db.prepare("SELECT * FROM physical_resource_checkouts WHERE resource_id = ? AND returned_at IS NULL LIMIT 1")
    .bind(resourceId)
    .first();
}

async function getCheckoutById(db, checkoutId) {
  return await db.prepare(`
    SELECT
      c.*,
      COALESCE(hu.name, c.holder_name) AS holder_display_name,
      COALESCE(hu.email, c.holder_email) AS holder_display_email
    FROM physical_resource_checkouts c
    LEFT JOIN users hu ON hu.id = c.holder_user_id
    WHERE c.id = ?
    LIMIT 1
  `).bind(checkoutId).first();
}

function rowFromPhysicalResource(resource) {
  return {
    name: resource.name,
    category: resource.category,
    inventory_code: resource.inventoryCode,
    asset_tag: resource.assetTag,
    serial_number: resource.serialNumber,
    description: resource.description,
    location: resource.location,
    condition: resource.condition,
    status: resource.status,
    notes: resource.notes,
    metadata: resource.metadata
  };
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeCondition(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeEmail(value) {
  const email = stringOrNull(value);
  return email ? email.toLowerCase() : null;
}

function normalizeIsoOrNull(value) {
  const raw = stringOrNull(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw validationError("due_at must be an ISO datetime");
  return date.toISOString();
}

function stringifyMetadata(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata must be an object");
      return JSON.stringify(parsed);
    } catch {
      throw validationError("metadata must be a JSON object");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validationError("metadata must be an object");
  return JSON.stringify(value);
}

function validationError(errors) {
  const normalized = Array.isArray(errors) ? errors : [errors];
  return Object.assign(new Error("Validation failed"), {
    status: 400,
    code: "validation_error",
    errors: normalized
  });
}

function generateId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
