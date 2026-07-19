import { generateId } from "../event-platform.js";
import { parseJsonArray, stringOrNull } from "./shared.js";
import { updateEventInstanceClockById } from "./events.js";

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

function validateSchedule(scheduleMode, anchorKey, offsetDays, dueAt) {
  if (scheduleMode === "relative" && (!anchorKey || offsetDays === null)) fail("relative items require anchor_key and integer offset_days");
  if (scheduleMode === "fixed" && !dueAt) fail("fixed items require due_at");
  if (scheduleMode === "fixed" && (anchorKey || offsetDays !== null)) fail("fixed items cannot include relative scheduling fields");
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
  return await updateEventInstanceClockById(db, instanceId, input, { now });
}

export async function createTimelineTemplateVersion(db, input = {}, actor = null, { now = new Date() } = {}) {
  const created = nowIso(now);
  const templateId = stringOrNull(input.template_id ?? input.templateId) || generateId("timeline_template");
  const template = await first(db, "SELECT * FROM timeline_templates WHERE id = ?", templateId);
  const name = required(input.name ?? template?.name, "name");
  const latest = await first(db, "SELECT MAX(version_number) AS version_number FROM timeline_template_versions WHERE template_id = ?", templateId);
  const versionNumber = Number(latest?.version_number || 0) + 1;
  const versionId = stringOrNull(input.id) || generateId("timeline_version");
  const anchors = Array.isArray(input.anchors) ? input.anchors : [];
  const items = Array.isArray(input.items) ? input.items : [];
  const snapshot = { name, description: stringOrNull(input.description), anchors, items };
  const writes = [];
  if (!template) writes.push(db.prepare("INSERT INTO timeline_templates (id, name, description, active, created_at, created_by_user_id) VALUES (?, ?, ?, 1, ?, ?)").bind(templateId, name, stringOrNull(input.description), created, actorId(actor)));
  writes.push(db.prepare(`INSERT INTO timeline_template_versions (id, template_id, version_number, name, snapshot_json, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(versionId, templateId, versionNumber, name, JSON.stringify(snapshot), created, actorId(actor)));
  for (const anchor of anchors) {
    const key = required(anchor.key ?? anchor.anchor_key, "anchor key");
    const source = stringOrNull(anchor.source) || "manual";
    if (!ANCHOR_SOURCES.has(source)) fail("anchor source is invalid");
    writes.push(db.prepare("INSERT INTO timeline_template_anchors (id, template_version_id, anchor_key, default_offset_days, source) VALUES (?, ?, ?, ?, ?)").bind(generateId("tta"), versionId, key, intOrNull(anchor.default_offset_days ?? anchor.defaultOffsetDays) || 0, source));
  }
  for (const item of items) {
    const scheduleMode = stringOrNull(item.schedule_mode ?? item.scheduleMode) || "relative";
    if (!SCHEDULE_MODES.has(scheduleMode)) fail("schedule_mode must be relative or fixed");
    const anchorKey = stringOrNull(item.anchor_key ?? item.anchorKey); const offsetDays = intOrNull(item.offset_days ?? item.offsetDays); const dueAt = dateOrNull(item.due_at ?? item.dueAt); validateSchedule(scheduleMode, anchorKey, offsetDays, dueAt);
    writes.push(db.prepare(`INSERT INTO timeline_template_items (id, template_version_id, item_key, type, title, priority, schedule_mode, anchor_key, offset_days, due_at, evidence_required, dependency_keys_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(generateId("tti"), versionId, required(item.key ?? item.item_key, "item key"), stringOrNull(item.type) || "task", required(item.title, "item title"), stringOrNull(item.priority) || "normal", scheduleMode,
        anchorKey, offsetDays, dueAt, item.evidence_required ? 1 : 0, JSON.stringify(Array.isArray(item.depends_on) ? item.depends_on : [])));
  }
  if (typeof db.batch === "function") await db.batch(writes); else for (const write of writes) await write.run();
  return await getTimelineTemplateVersion(db, versionId);
}

export async function getTimelineTemplateVersion(db, versionId) {
  const version = await first(db, "SELECT * FROM timeline_template_versions WHERE id = ?", versionId);
  if (!version) return null;
  const anchors = await all(db, "SELECT * FROM timeline_template_anchors WHERE template_version_id = ? ORDER BY anchor_key", versionId);
  const items = await all(db, "SELECT * FROM timeline_template_items WHERE template_version_id = ? ORDER BY item_key", versionId);
  // Normalized rows are the runtime source of truth; snapshot_json is retained as an audit artifact.
  return { ...version, anchors, items };
}

export async function listTimelineTemplateVersions(db) {
  const versions = await all(db, `SELECT v.id, v.template_id, v.version_number, v.name, v.instantiated_at, v.created_at, t.description
    FROM timeline_template_versions v JOIN timeline_templates t ON t.id = v.template_id
    ORDER BY v.created_at DESC, v.version_number DESC`);
  return versions;
}

function validateTemplateGraph(version) {
  const anchors = new Set(version.anchors.map((anchor) => anchor.anchor_key));
  const itemsByKey = new Map(version.items.map((item) => [item.item_key, item]));
  if (itemsByKey.size !== version.items.length) fail("Template contains duplicate item keys", 409);
  const dependencies = [];
  for (const item of version.items) {
    validateSchedule(item.schedule_mode, item.anchor_key, item.offset_days, item.due_at);
    if (item.schedule_mode === "relative" && !anchors.has(item.anchor_key)) fail(`Template item ${item.item_key} references an unknown anchor`, 409);
    for (const dependencyKey of parseJsonArray(item.dependency_keys_json, [])) {
      if (!itemsByKey.has(dependencyKey)) fail(`Template item ${item.item_key} references an unknown dependency`, 409);
      if (dependencyKey === item.item_key) fail("A template item cannot depend on itself", 409);
      dependencies.push([item.item_key, dependencyKey]);
    }
  }
  const visiting = new Set(); const visited = new Set();
  const walk = (key) => {
    if (visiting.has(key)) fail("Template dependencies contain a cycle", 409);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const [from, to] of dependencies) if (from === key) walk(to);
    visiting.delete(key); visited.add(key);
  };
  for (const key of itemsByKey.keys()) walk(key);
  return { dependencies };
}

function existingPlanMatchesTemplate(timeline, version, dependencies) {
  const templateItemIds = new Set(version.items.map((item) => item.id));
  const expectedAnchors = new Set(version.anchors.map((anchor) => anchor.anchor_key));
  if (timeline.items.length !== version.items.length || timeline.anchors.length !== version.anchors.length) return false;
  if (!timeline.items.every((item) => templateItemIds.has(item.template_item_id))) return false;
  if (!timeline.anchors.every((anchor) => expectedAnchors.has(anchor.anchor_key))) return false;
  return timeline.dependencies.length === dependencies.length;
}

export async function instantiateEventPlan(db, eventInstanceId, templateVersionId, actor = null, { now = new Date() } = {}) {
  const existing = await first(db, "SELECT * FROM event_plans WHERE event_instance_id = ?", eventInstanceId);
  const version = await getTimelineTemplateVersion(db, templateVersionId);
  if (!version) fail("Timeline template version not found", 404);
  const graph = validateTemplateGraph(version);
  if (existing) {
    if (existing.template_version_id !== templateVersionId) fail("Event plan already exists for a different template version", 409);
    const timeline = await getEventPlanTimeline(db, existing.id);
    if (!existingPlanMatchesTemplate(timeline, version, graph.dependencies)) fail("Existing event plan is incomplete; refusing to return a broken retry", 409);
    return timeline;
  }
  const eventInstance = await first(db, "SELECT * FROM event_instances WHERE id = ?", eventInstanceId);
  if (!eventInstance) fail("Event instance not found", 404);
  const created = nowIso(now);
  const planId = generateId("event_plan");
  const statements = [db.prepare("INSERT INTO event_plans (id, event_instance_id, template_version_id, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?)")
    .bind(planId, eventInstanceId, templateVersionId, created, actorId(actor))];
  const anchorDates = new Map();
  for (const anchor of version.anchors) {
    const date = anchor.source === "event_start" ? eventInstance.starts_at : anchor.source === "event_end" ? eventInstance.ends_at : null;
    anchorDates.set(anchor.anchor_key, date);
    statements.push(db.prepare("INSERT INTO event_plan_anchors (id, event_plan_id, anchor_key, occurs_at, source, updated_by_user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(generateId("epa"), planId, anchor.anchor_key, date, anchor.source, actorId(actor), created));
  }
  const itemIds = new Map();
  for (const item of version.items) {
    const id = generateId("epi");
    itemIds.set(item.item_key, id);
    const anchorDate = anchorDates.get(item.anchor_key);
    const dueAt = item.schedule_mode === "relative" && anchorDate && item.offset_days !== null ? addDays(anchorDate, item.offset_days) : item.due_at;
    statements.push(db.prepare(`INSERT INTO event_plan_items (id, event_plan_id, template_item_id, type, title, status, priority, anchor_key, offset_days, schedule_mode, due_at, evidence_required, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, planId, item.id, item.type, item.title, item.priority, item.anchor_key, item.offset_days, item.schedule_mode, dueAt, item.evidence_required, created, created));
    statements.push(db.prepare("INSERT INTO event_plan_item_events (id, event_plan_item_id, event_type, actor_user_id, data_json, occurred_at) VALUES (?, ?, 'created_from_template', ?, ?, ?)")
      .bind(generateId("epie"), id, actorId(actor), JSON.stringify({ templateItemId: item.id }), created));
  }
  for (const [itemKey, dependencyKey] of graph.dependencies) {
    const itemId = itemIds.get(itemKey); const dependencyId = itemIds.get(dependencyKey);
    statements.push(db.prepare("INSERT INTO event_plan_dependencies (id, event_plan_item_id, depends_on_item_id, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(generateId("epd"), itemId, dependencyId, actorId(actor), created));
    statements.push(db.prepare("INSERT INTO event_plan_item_events (id, event_plan_item_id, event_type, actor_user_id, data_json, occurred_at) VALUES (?, ?, 'dependency_added', ?, ?, ?)")
      .bind(generateId("epie"), itemId, actorId(actor), JSON.stringify({ dependsOnItemId: dependencyId }), created));
  }
  statements.push(db.prepare("UPDATE timeline_template_versions SET instantiated_at = COALESCE(instantiated_at, ?) WHERE id = ?").bind(created, templateVersionId));
  if (typeof db.batch === "function") await db.batch(statements); else for (const statement of statements) await statement.run();
  return await getEventPlanTimeline(db, planId);
}

export async function createPlanAnchor(db, eventPlanId, input = {}, actor = null, { now = new Date() } = {}) {
  const key = required(input.key ?? input.anchor_key ?? input.anchorKey, "anchor key");
  const source = stringOrNull(input.source) || "manual";
  if (!ANCHOR_SOURCES.has(source)) fail("anchor source is invalid");
  const existing = await first(db, "SELECT source FROM event_plan_anchors WHERE event_plan_id = ? AND anchor_key = ?", eventPlanId, key);
  if (source === "event_start" || source === "event_end" || existing?.source === "event_start" || existing?.source === "event_end") fail("Event anchors are projected from the EventInstance and cannot be set directly", 409);
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
  validateSchedule(scheduleMode, anchorKey, offsetDays, dueAt);
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
  if (type !== "user") fail("Only user assignments are supported");
  if (!await first(db, "SELECT id FROM users WHERE id = ?", id)) fail("Assigned user not found", 404);
  if (await first(db, "SELECT id FROM event_plan_assignments WHERE event_plan_item_id = ? AND assignee_type = ? AND assignee_id = ? AND ended_at IS NULL", itemId, type, id)) return false;
  const timestamp = nowIso(now);
  await db.prepare("INSERT INTO event_plan_assignments (id, event_plan_item_id, assignee_type, assignee_id, assigned_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(generateId("epa"), itemId, type, id, actorId(actor), timestamp).run();
  await appendItemEvent(db, itemId, "assigned", actor, { assigneeType: type, assigneeId: id }, now);
  return true;
}

export async function reschedulePlanItem(db, itemId, input = {}, actor = null, { now = new Date() } = {}) {
  const item = await first(db, "SELECT * FROM event_plan_items WHERE id = ?", itemId);
  if (!item) fail("Plan item not found", 404);
  const dueAt = dateOrNull(input.due_at ?? input.dueAt);
  if (item.due_at === dueAt && item.manual_override_at) return item;
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
  if (item.status === status) return item;
  if (status === "completed") {
    if (item.evidence_required && !await first(db, "SELECT id FROM event_plan_item_evidence WHERE event_plan_item_id = ? LIMIT 1", itemId)) fail("Evidence is required before completing this item", 409);
    const openPrerequisite = await first(db, `SELECT prerequisite.id FROM event_plan_dependencies dependency
      JOIN event_plan_items prerequisite ON prerequisite.id = dependency.depends_on_item_id
      WHERE dependency.event_plan_item_id = ? AND prerequisite.status != 'completed' LIMIT 1`, itemId);
    if (openPrerequisite) fail("All prerequisite items must be completed first", 409);
  }
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
  const label = required(input.label, "evidence label"); const url = stringOrNull(input.url);
  if (await first(db, "SELECT id FROM event_plan_item_evidence WHERE event_plan_item_id = ? AND label = ? AND (url IS ? OR url = ?)", itemId, label, url, url)) return false;
  await db.prepare("INSERT INTO event_plan_item_evidence (id, event_plan_item_id, label, url, attached_by_user_id, attached_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(generateId("epievidence"), itemId, label, url, actorId(actor), timestamp).run();
  await appendItemEvent(db, itemId, "evidence_attached", actor, {}, now);
  return true;
}

export async function createPlanDependency(db, itemId, dependsOnItemId, actor = null, { now = new Date() } = {}) {
  if (itemId === dependsOnItemId) fail("A plan item cannot depend on itself");
  const items = await all(db, "SELECT id, event_plan_id FROM event_plan_items WHERE id IN (?, ?)", itemId, dependsOnItemId);
  if (items.length !== 2 || items[0].event_plan_id !== items[1].event_plan_id) fail("Dependencies must stay within one event plan", 409);
  const existing = await first(db, "SELECT id FROM event_plan_dependencies WHERE event_plan_item_id = ? AND depends_on_item_id = ?", itemId, dependsOnItemId);
  if (existing) return false;
  const cycle = await first(db, `WITH RECURSIVE chain(id) AS (SELECT depends_on_item_id FROM event_plan_dependencies WHERE event_plan_item_id = ? UNION SELECT d.depends_on_item_id FROM event_plan_dependencies d JOIN chain c ON d.event_plan_item_id = c.id) SELECT id FROM chain WHERE id = ? LIMIT 1`, dependsOnItemId, itemId);
  if (cycle) fail("Dependency would create a cycle", 409);
  await db.prepare("INSERT INTO event_plan_dependencies (id, event_plan_item_id, depends_on_item_id, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(generateId("epd"), itemId, dependsOnItemId, actorId(actor), nowIso(now)).run();
  await appendItemEvent(db, itemId, "dependency_added", actor, { dependsOnItemId }, now);
  return true;
}

export async function removePlanDependency(db, itemId, dependsOnItemId, actor = null, { now = new Date() } = {}) {
  if (!await first(db, "SELECT id FROM event_plan_dependencies WHERE event_plan_item_id = ? AND depends_on_item_id = ?", itemId, dependsOnItemId)) return false;
  await db.prepare("DELETE FROM event_plan_dependencies WHERE event_plan_item_id = ? AND depends_on_item_id = ?").bind(itemId, dependsOnItemId).run();
  await appendItemEvent(db, itemId, "dependency_removed", actor, { dependsOnItemId }, now);
  return true;
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
  const anchors = (await all(db, "SELECT * FROM event_plan_anchors WHERE event_plan_id = ? ORDER BY anchor_key", eventPlanId)).map((anchor) => ({
    ...anchor,
    occurs_at: anchor.source === "event_start" ? plan.event_starts_at : anchor.source === "event_end" ? plan.event_ends_at : anchor.occurs_at
  }));
  return { plan, anchors, anchorEvents, items: filtered, events, evidence, dependencies, assignments };
}

export async function previewAnchorShift(db, eventPlanId, input = {}) {
  const anchorKey = required(input.anchor_key ?? input.anchorKey, "anchor_key");
  const timeline = await getEventPlanTimeline(db, eventPlanId);
  if (!timeline) fail("Event plan not found", 404);
  const anchor = timeline.anchors.find((row) => row.anchor_key === anchorKey);
  if (!anchor?.occurs_at) fail("Anchor must have a date before it can shift", 409);
  if (anchor.source === "event_start" || anchor.source === "event_end") fail("Event anchors must be changed through the EventInstance", 409);
  const nextOccursAt = dateOrNull(input.occurs_at ?? input.occursAt, "occurs_at");
  if (!nextOccursAt) fail("occurs_at is required");
  const deltaMs = Date.parse(nextOccursAt) - Date.parse(anchor.occurs_at);
  const items = timeline.items.map((item) => {
    let reason = null;
    if (item.anchor_key !== anchorKey) reason = "different_anchor";
    else if (item.status === "completed") reason = "completed";
    else if (item.schedule_mode === "fixed") reason = "fixed";
    else if (item.manual_override_at) reason = "manual_override";
    else if (!item.due_at) reason = "no_due_date";
    return { itemId: item.id, title: item.title, before: item.due_at, after: reason ? item.due_at : new Date(Date.parse(item.due_at) + deltaMs).toISOString(), moved: !reason, reason };
  });
  const previewToken = fingerprint({ eventPlanId, anchorKey, before: anchor.occurs_at, after: nextOccursAt, items: timeline.items.map((item) => ({ id: item.id, status: item.status, dueAt: item.due_at, scheduleMode: item.schedule_mode, anchorKey: item.anchor_key, manualOverrideAt: item.manual_override_at })) });
  return { eventPlanId, anchorKey, before: anchor.occurs_at, after: nextOccursAt, deltaMs, items, previewToken };
}

export async function applyAnchorShift(db, eventPlanId, input = {}, actor = null, { now = new Date() } = {}) {
  const preview = await previewAnchorShift(db, eventPlanId, input);
  const suppliedToken = stringOrNull(input.preview_token ?? input.previewToken);
  if (!suppliedToken || suppliedToken !== preview.previewToken) fail("Shift preview is stale; preview again before applying", 409);
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

function fingerprint(value) {
  const source = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `preview_${(hash >>> 0).toString(36)}`;
}
