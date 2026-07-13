import { generateId } from "../event-platform.js";
import { parseJsonArray, stringOrNull } from "./shared.js";

const ANCHOR_SOURCES = new Set(["event_start", "event_end", "manual", "derived"]);
const SCHEDULE_MODES = new Set(["relative", "fixed"]);
const ITEM_STATUSES = new Set(["open", "blocked", "completed"]);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function intOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function required(value, label) {
  const normalized = stringOrNull(value);
  if (!normalized) fail(`${label} is required`);
  return normalized;
}

function dateOrNull(value, label = "date") {
  const normalized = stringOrNull(value);
  if (!normalized) return null;
  if (Number.isNaN(Date.parse(normalized))) fail(`${label} must be an ISO date/time`);
  return new Date(normalized).toISOString();
}

function addDays(iso, days) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function actorId(actor) {
  return stringOrNull(actor?.userId ?? actor?.user_id ?? actor?.id ?? actor);
}

async function first(db, sql, ...binds) {
  return await db.prepare(sql).bind(...binds).first();
}

async function all(db, sql, ...binds) {
  const result = await db.prepare(sql).bind(...binds).all();
  return result.results || [];
}

async function appendItemEvent(db, itemId, eventType, actor, data = {}, now = new Date()) {
  await db.prepare(`INSERT INTO event_plan_item_events (id, event_plan_item_id, event_type, actor_user_id, data_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(generateId("epie"), itemId, eventType, actorId(actor), JSON.stringify(data), nowIso(now)).run();
}

function assertTemplateVersionMutable(version) {
  if (version?.instantiated_at) fail("Template versions are immutable after first instantiation.", 409);
}

export async function createDraftEventInstance(db, input = {}, actor = null, { now = new Date() } = {}) {
  const eventSlug = required(input.event_slug ?? input.eventSlug, "event_slug");
  const event = await first(db, "SELECT * FROM events WHERE slug = ?", eventSlug);
  if (!event) fail("Event series not found", 404);
  const id = stringOrNull(input.id) || generateId("event_instance");
  const created = nowIso(now);
  const key = stringOrNull(input.instance_key ?? input.instanceKey) || `draft-${id.slice(-12)}`;
  await db.prepare(`INSERT INTO event_instances (id, event_slug, instance_key, title, starts_at, ends_at, venue_name, venue_address, capacity, status, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'draft', ?, ?, ?)`)
    .bind(id, eventSlug, key, stringOrNull(input.title) || event.title, stringOrNull(input.venue_name), stringOrNull(input.venue_address), intOrNull(input.capacity), JSON.stringify({ planning_draft: true }), created, created).run();
  return await first(db, "SELECT * FROM event_instances WHERE id = ?", id);
}

export async function updateEventInstanceById(db, instanceId, input = {}, actor = null, { now = new Date() } = {}) {
  const existing = await first(db, "SELECT * FROM event_instances WHERE id = ?", instanceId);
  if (!existing) fail("Event instance not found", 404);
  const updated = nowIso(now);
  const startsAt = input.starts_at === undefined && input.startsAt === undefined ? existing.starts_at : dateOrNull(input.starts_at ?? input.startsAt, "starts_at");
  const endsAt = input.ends_at === undefined && input.endsAt === undefined ? existing.ends_at : dateOrNull(input.ends_at ?? input.endsAt, "ends_at");
  if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) fail("ends_at must be after starts_at");
  await db.prepare(`UPDATE event_instances SET title = ?, starts_at = ?, ends_at = ?, venue_name = ?, venue_address = ?, capacity = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(stringOrNull(input.title) ?? existing.title, startsAt, endsAt, stringOrNull(input.venue_name) ?? existing.venue_name,
      stringOrNull(input.venue_address) ?? existing.venue_address, input.capacity === undefined ? existing.capacity : intOrNull(input.capacity),
      stringOrNull(input.status) || existing.status, updated, instanceId).run();
  return await first(db, "SELECT * FROM event_instances WHERE id = ?", instanceId);
}

export async function createTimelineTemplateVersion(db, input = {}, actor = null, { now = new Date() } = {}) {
  const created = nowIso(now);
  const templateId = stringOrNull(input.template_id ?? input.templateId) || generateId("timeline_template");
  const template = await first(db, "SELECT * FROM timeline_templates WHERE id = ?", templateId);
  const name = required(input.name ?? template?.name, "name");
  if (!template) {
    await db.prepare("INSERT INTO timeline_templates (id, name, description, active, created_at, created_by_user_id) VALUES (?, ?, ?, 1, ?, ?)")
      .bind(templateId, name, stringOrNull(input.description), created, actorId(actor)).run();
  }
  const latest = await first(db, "SELECT MAX(version_number) AS version_number FROM timeline_template_versions WHERE template_id = ?", templateId);
  const versionNumber = Number(latest?.version_number || 0) + 1;
  const versionId = stringOrNull(input.id) || generateId("timeline_version");
  const anchors = Array.isArray(input.anchors) ? input.anchors : [];
  const items = Array.isArray(input.items) ? input.items : [];
  const snapshot = { name, description: stringOrNull(input.description), anchors, items };
  await db.prepare(`INSERT INTO timeline_template_versions (id, template_id, version_number, name, snapshot_json, created_at, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(versionId, templateId, versionNumber, name, JSON.stringify(snapshot), created, actorId(actor)).run();
  for (const anchor of anchors) {
    const key = required(anchor.key ?? anchor.anchor_key, "anchor key");
    const source = stringOrNull(anchor.source) || "manual";
    if (!ANCHOR_SOURCES.has(source)) fail("anchor source is invalid");
    await db.prepare("INSERT INTO timeline_template_anchors (id, template_version_id, anchor_key, default_offset_days, source) VALUES (?, ?, ?, ?, ?)")
      .bind(generateId("tta"), versionId, key, intOrNull(anchor.default_offset_days ?? anchor.defaultOffsetDays) || 0, source).run();
  }
  for (const item of items) {
    const scheduleMode = stringOrNull(item.schedule_mode ?? item.scheduleMode) || "relative";
    if (!SCHEDULE_MODES.has(scheduleMode)) fail("schedule_mode must be relative or fixed");
    await db.prepare(`INSERT INTO timeline_template_items (id, template_version_id, item_key, type, title, priority, schedule_mode, anchor_key, offset_days, due_at, evidence_required, dependency_keys_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(generateId("tti"), versionId, required(item.key ?? item.item_key, "item key"), stringOrNull(item.type) || "task", required(item.title, "item title"), stringOrNull(item.priority) || "normal", scheduleMode,
        stringOrNull(item.anchor_key ?? item.anchorKey), intOrNull(item.offset_days ?? item.offsetDays), dateOrNull(item.due_at ?? item.dueAt), item.evidence_required ? 1 : 0,
        JSON.stringify(Array.isArray(item.depends_on) ? item.depends_on : [])).run();
  }
  return await getTimelineTemplateVersion(db, versionId);
}

export async function getTimelineTemplateVersion(db, versionId) {
  const version = await first(db, "SELECT * FROM timeline_template_versions WHERE id = ?", versionId);
  if (!version) return null;
  return { ...version, anchors: await all(db, "SELECT * FROM timeline_template_anchors WHERE template_version_id = ? ORDER BY anchor_key", versionId), items: await all(db, "SELECT * FROM timeline_template_items WHERE template_version_id = ? ORDER BY item_key", versionId) };
}

export async function instantiateEventPlan(db, eventInstanceId, templateVersionId, actor = null, { now = new Date() } = {}) {
  const existing = await first(db, "SELECT * FROM event_plans WHERE event_instance_id = ?", eventInstanceId);
  if (existing) return await getEventPlanTimeline(db, existing.id);
  const eventInstance = await first(db, "SELECT * FROM event_instances WHERE id = ?", eventInstanceId);
  if (!eventInstance) fail("Event instance not found", 404);
  const version = await getTimelineTemplateVersion(db, templateVersionId);
  if (!version) fail("Timeline template version not found", 404);
  const created = nowIso(now);
  const planId = generateId("event_plan");
  await db.prepare("INSERT INTO event_plans (id, event_instance_id, template_version_id, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?)")
    .bind(planId, eventInstanceId, templateVersionId, created, actorId(actor)).run();
  const anchorDates = new Map();
  for (const anchor of version.anchors) {
    const date = anchor.source === "event_start" ? eventInstance.starts_at : anchor.source === "event_end" ? eventInstance.ends_at : null;
    anchorDates.set(anchor.anchor_key, date);
    await db.prepare("INSERT INTO event_plan_anchors (id, event_plan_id, anchor_key, occurs_at, source, updated_by_user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(generateId("epa"), planId, anchor.anchor_key, date, anchor.source, actorId(actor), created).run();
  }
  const itemIds = new Map();
  for (const item of version.items) {
    const id = generateId("epi");
    itemIds.set(item.item_key, id);
    const anchorDate = anchorDates.get(item.anchor_key);
    const dueAt = item.schedule_mode === "relative" && anchorDate && item.offset_days !== null ? addDays(anchorDate, item.offset_days) : item.due_at;
    await db.prepare(`INSERT INTO event_plan_items (id, event_plan_id, template_item_id, type, title, status, priority, anchor_key, offset_days, schedule_mode, due_at, evidence_required, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, planId, item.id, item.type, item.title, item.priority, item.anchor_key, item.offset_days, item.schedule_mode, dueAt, item.evidence_required, created, created).run();
    await appendItemEvent(db, id, "created_from_template", actor, { templateItemId: item.id }, now);
  }
  for (const item of version.items) {
    for (const dependencyKey of parseJsonArray(item.dependency_keys_json, [])) {
      const dependentId = itemIds.get(item.item_key);
      const dependencyId = itemIds.get(dependencyKey);
      if (dependentId && dependencyId) await createPlanDependency(db, dependentId, dependencyId, actor, { now });
    }
  }
  await db.prepare("UPDATE timeline_template_versions SET instantiated_at = COALESCE(instantiated_at, ?) WHERE id = ?").bind(created, templateVersionId).run();
  return await getEventPlanTimeline(db, planId);
}

export async function createPlanAnchor(db, eventPlanId, input = {}, actor = null, { now = new Date() } = {}) {
  const key = required(input.key ?? input.anchor_key ?? input.anchorKey, "anchor key");
  const source = stringOrNull(input.source) || "manual";
  if (!ANCHOR_SOURCES.has(source)) fail("anchor source is invalid");
  const timestamp = nowIso(now);
  await db.prepare(`INSERT INTO event_plan_anchors (id, event_plan_id, anchor_key, occurs_at, source, updated_by_user_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_plan_id, anchor_key) DO UPDATE SET occurs_at = excluded.occurs_at, source = excluded.source, updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`)
    .bind(generateId("epa"), eventPlanId, key, dateOrNull(input.occurs_at ?? input.occursAt), source, actorId(actor), timestamp).run();
  await db.prepare("INSERT INTO event_plan_anchor_events (id, event_plan_id, anchor_key, event_type, actor_user_id, data_json, occurred_at) VALUES (?, ?, ?, 'updated', ?, ?, ?)")
    .bind(generateId("epae"), eventPlanId, key, actorId(actor), JSON.stringify({ source, occursAt: dateOrNull(input.occurs_at ?? input.occursAt) }), timestamp).run();
  return await first(db, "SELECT * FROM event_plan_anchors WHERE event_plan_id = ? AND anchor_key = ?", eventPlanId, key);
}

export async function createPlanItem(db, eventPlanId, input = {}, actor = null, { now = new Date() } = {}) {
  const plan = await first(db, "SELECT id FROM event_plans WHERE id = ?", eventPlanId);
  if (!plan) fail("Event plan not found", 404);
  const scheduleMode = stringOrNull(input.schedule_mode ?? input.scheduleMode) || "relative";
  if (!SCHEDULE_MODES.has(scheduleMode)) fail("schedule_mode must be relative or fixed");
  const anchorKey = stringOrNull(input.anchor_key ?? input.anchorKey);
  const offsetDays = intOrNull(input.offset_days ?? input.offsetDays);
  let dueAt = dateOrNull(input.due_at ?? input.dueAt);
  if (scheduleMode === "relative" && anchorKey && offsetDays !== null && !dueAt) {
    const anchor = await first(db, "SELECT occurs_at FROM event_plan_anchors WHERE event_plan_id = ? AND anchor_key = ?", eventPlanId, anchorKey);
    if (anchor?.occurs_at) dueAt = addDays(anchor.occurs_at, offsetDays);
  }
  const timestamp = nowIso(now);
  const id = generateId("epi");
  await db.prepare(`INSERT INTO event_plan_items (id, event_plan_id, type, title, status, priority, anchor_key, offset_days, schedule_mode, due_at, evidence_required, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, eventPlanId, stringOrNull(input.type) || "task", required(input.title, "title"), stringOrNull(input.priority) || "normal", anchorKey, offsetDays, scheduleMode, dueAt, input.evidence_required ? 1 : 0, timestamp, timestamp).run();
  await appendItemEvent(db, id, "created", actor, { oneOff: true }, now);
  return await first(db, "SELECT * FROM event_plan_items WHERE id = ?", id);
}

export async function assignPlanItem(db, itemId, input = {}, actor = null, { now = new Date() } = {}) {
  const type = required(input.assignee_type ?? input.assigneeType, "assignee_type");
  const id = required(input.assignee_id ?? input.assigneeId, "assignee_id");
  if (!["user", "team", "role"].includes(type)) fail("assignee_type must be user, team, or role");
  if (type === "user" && !await first(db, "SELECT id FROM users WHERE id = ?", id)) fail("Assigned user not found", 404);
  const timestamp = nowIso(now);
  await db.prepare("INSERT INTO event_plan_assignments (id, event_plan_item_id, assignee_type, assignee_id, assigned_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(generateId("epa"), itemId, type, id, actorId(actor), timestamp).run();
  await appendItemEvent(db, itemId, "assigned", actor, { assigneeType: type, assigneeId: id }, now);
}

export async function reschedulePlanItem(db, itemId, input = {}, actor = null, { now = new Date() } = {}) {
  const item = await first(db, "SELECT * FROM event_plan_items WHERE id = ?", itemId);
  if (!item) fail("Plan item not found", 404);
  const dueAt = dateOrNull(input.due_at ?? input.dueAt);
  const timestamp = nowIso(now);
  await db.prepare("UPDATE event_plan_items SET due_at = ?, manual_override_at = ?, manual_override_by_user_id = ?, updated_at = ? WHERE id = ?")
    .bind(dueAt, timestamp, actorId(actor), timestamp, itemId).run();
  await appendItemEvent(db, itemId, "rescheduled", actor, { dueAt, manualOverride: true }, now);
  return await first(db, "SELECT * FROM event_plan_items WHERE id = ?", itemId);
}

export async function transitionPlanItem(db, itemId, status, actor = null, { now = new Date() } = {}) {
  if (!ITEM_STATUSES.has(status)) fail("Invalid plan item status");
  const item = await first(db, "SELECT * FROM event_plan_items WHERE id = ?", itemId);
  if (!item) fail("Plan item not found", 404);
  const timestamp = nowIso(now);
  await db.prepare("UPDATE event_plan_items SET status = ?, completed_at = ?, completed_by_user_id = ?, updated_at = ? WHERE id = ?")
    .bind(status, status === "completed" ? timestamp : null, status === "completed" ? actorId(actor) : null, timestamp, itemId).run();
  await appendItemEvent(db, itemId, status, actor, {}, now);
  return await first(db, "SELECT * FROM event_plan_items WHERE id = ?", itemId);
}

export const completePlanItem = (db, id, actor, options) => transitionPlanItem(db, id, "completed", actor, options);
export const reopenPlanItem = (db, id, actor, options) => transitionPlanItem(db, id, "open", actor, options);
export const blockPlanItem = (db, id, actor, options) => transitionPlanItem(db, id, "blocked", actor, options);
export const unblockPlanItem = (db, id, actor, options) => transitionPlanItem(db, id, "open", actor, options);

export async function attachPlanEvidence(db, itemId, input = {}, actor = null, { now = new Date() } = {}) {
  const timestamp = nowIso(now);
  await db.prepare("INSERT INTO event_plan_item_evidence (id, event_plan_item_id, label, url, attached_by_user_id, attached_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(generateId("epievidence"), itemId, required(input.label, "evidence label"), stringOrNull(input.url), actorId(actor), timestamp).run();
  await appendItemEvent(db, itemId, "evidence_attached", actor, {}, now);
}

export async function createPlanDependency(db, itemId, dependsOnItemId, actor = null, { now = new Date() } = {}) {
  if (itemId === dependsOnItemId) fail("A plan item cannot depend on itself");
  await db.prepare("INSERT OR IGNORE INTO event_plan_dependencies (id, event_plan_item_id, depends_on_item_id, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(generateId("epd"), itemId, dependsOnItemId, actorId(actor), nowIso(now)).run();
  await appendItemEvent(db, itemId, "dependency_added", actor, { dependsOnItemId }, now);
}

export async function removePlanDependency(db, itemId, dependsOnItemId, actor = null, { now = new Date() } = {}) {
  await db.prepare("DELETE FROM event_plan_dependencies WHERE event_plan_item_id = ? AND depends_on_item_id = ?").bind(itemId, dependsOnItemId).run();
  await appendItemEvent(db, itemId, "dependency_removed", actor, { dependsOnItemId }, now);
}

export async function getEventPlanTimeline(db, eventPlanId, filters = {}) {
  const plan = await first(db, `SELECT p.*, ei.event_slug, ei.title AS event_title, ei.starts_at AS event_starts_at, ei.ends_at AS event_ends_at
    FROM event_plans p JOIN event_instances ei ON ei.id = p.event_instance_id WHERE p.id = ?`, eventPlanId);
  if (!plan) return null;
  const items = await all(db, "SELECT * FROM event_plan_items WHERE event_plan_id = ? ORDER BY due_at IS NULL, due_at, created_at", eventPlanId);
  const filtered = filters.status ? items.filter((item) => item.status === filters.status) : items;
  const itemIds = filtered.map((item) => item.id);
  const events = itemIds.length ? await all(db, `SELECT * FROM event_plan_item_events WHERE event_plan_item_id IN (${itemIds.map(() => "?").join(",")}) ORDER BY occurred_at DESC`, ...itemIds) : [];
  const evidence = itemIds.length ? await all(db, `SELECT * FROM event_plan_item_evidence WHERE event_plan_item_id IN (${itemIds.map(() => "?").join(",")}) ORDER BY attached_at DESC`, ...itemIds) : [];
  const dependencies = itemIds.length ? await all(db, `SELECT * FROM event_plan_dependencies WHERE event_plan_item_id IN (${itemIds.map(() => "?").join("," )})`, ...itemIds) : [];
  const assignments = itemIds.length ? await all(db, `SELECT * FROM event_plan_assignments WHERE event_plan_item_id IN (${itemIds.map(() => "?").join(",")}) AND ended_at IS NULL`, ...itemIds) : [];
  const anchorEvents = await all(db, "SELECT * FROM event_plan_anchor_events WHERE event_plan_id = ? ORDER BY occurred_at DESC", eventPlanId);
  return { plan, anchors: await all(db, "SELECT * FROM event_plan_anchors WHERE event_plan_id = ? ORDER BY anchor_key", eventPlanId), anchorEvents, items: filtered, events, evidence, dependencies, assignments };
}

export async function previewAnchorShift(db, eventPlanId, input = {}) {
  const anchorKey = required(input.anchor_key ?? input.anchorKey, "anchor_key");
  const timeline = await getEventPlanTimeline(db, eventPlanId);
  if (!timeline) fail("Event plan not found", 404);
  const anchor = timeline.anchors.find((row) => row.anchor_key === anchorKey);
  if (!anchor?.occurs_at) fail("Anchor must have a date before it can shift", 409);
  const nextOccursAt = dateOrNull(input.occurs_at ?? input.occursAt, "occurs_at");
  if (!nextOccursAt) fail("occurs_at is required");
  const deltaDays = Math.round((Date.parse(nextOccursAt) - Date.parse(anchor.occurs_at)) / 86400000);
  const items = timeline.items.map((item) => {
    let reason = null;
    if (item.anchor_key !== anchorKey) reason = "different_anchor";
    else if (item.status === "completed") reason = "completed";
    else if (item.schedule_mode === "fixed") reason = "fixed";
    else if (item.manual_override_at) reason = "manual_override";
    else if (!item.due_at) reason = "no_due_date";
    return { itemId: item.id, title: item.title, before: item.due_at, after: reason ? item.due_at : addDays(item.due_at, deltaDays), moved: !reason, reason };
  });
  return { eventPlanId, anchorKey, before: anchor.occurs_at, after: nextOccursAt, deltaDays, items };
}

export async function applyAnchorShift(db, eventPlanId, input = {}, actor = null, { now = new Date() } = {}) {
  const preview = await previewAnchorShift(db, eventPlanId, input);
  const timestamp = nowIso(now);
  const statements = [db.prepare("UPDATE event_plan_anchors SET occurs_at = ?, updated_by_user_id = ?, updated_at = ? WHERE event_plan_id = ? AND anchor_key = ?")
    .bind(preview.after, actorId(actor), timestamp, eventPlanId, preview.anchorKey)];
  statements.push(db.prepare("INSERT INTO event_plan_anchor_events (id, event_plan_id, anchor_key, event_type, actor_user_id, data_json, occurred_at) VALUES (?, ?, ?, 'shifted', ?, ?, ?)")
    .bind(generateId("epae"), eventPlanId, preview.anchorKey, actorId(actor), JSON.stringify({ before: preview.before, after: preview.after }), timestamp));
  for (const item of preview.items.filter((item) => item.moved)) {
    statements.push(db.prepare("UPDATE event_plan_items SET due_at = ?, updated_at = ? WHERE id = ?").bind(item.after, timestamp, item.itemId));
    statements.push(db.prepare("INSERT INTO event_plan_item_events (id, event_plan_item_id, event_type, actor_user_id, data_json, occurred_at) VALUES (?, ?, 'anchor_shifted', ?, ?, ?)")
      .bind(generateId("epie"), item.itemId, actorId(actor), JSON.stringify({ anchorKey: preview.anchorKey, before: item.before, after: item.after }), timestamp));
  }
  if (typeof db.batch === "function") await db.batch(statements);
  else for (const statement of statements) await statement.run();
  return { ...preview, applied: true };
}
