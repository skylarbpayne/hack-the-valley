import { getDb, handleErrors, jsonResponse, methodNotAllowed, readJson, requireAdmin } from "../../../_lib/event-platform.js";
import {
  createDraftEventInstance,
  createPlanAnchor,
  createPlanItem,
  createTimelineTemplateVersion,
  getEventPlanTimeline,
  instantiateEventPlan,
  updateEventInstanceById
} from "../../../_lib/domain/event-planning.js";

function requireSessionAdmin(access) {
  if (access?.bootstrap || !access?.user?.id) throw Object.assign(new Error("A signed-in admin session is required."), { status: 403 });
  return access;
}

function actor(access) { return { userId: access.user.id }; }

export async function onRequestGet(context) {
  return handleErrors(async () => {
    requireSessionAdmin(await requireAdmin(context.request, context.env));
    const db = getDb(context.env);
    const url = new URL(context.request.url);
    const eventInstanceId = url.searchParams.get("event_instance_id");
    if (eventInstanceId) {
      const plan = await db.prepare("SELECT id FROM event_plans WHERE event_instance_id = ?").bind(eventInstanceId).first();
      return jsonResponse({ ok: true, timeline: plan ? await getEventPlanTimeline(db, plan.id) : null });
    }
    const result = await db.prepare(`SELECT p.id, p.event_instance_id, p.template_version_id, p.created_at, ei.title, ei.starts_at
      FROM event_plans p JOIN event_instances ei ON ei.id = p.event_instance_id ORDER BY p.created_at DESC`).all();
    return jsonResponse({ ok: true, plans: result.results || [] });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = requireSessionAdmin(await requireAdmin(context.request, context.env));
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const action = String(input.action || "").trim();
    if (action === "create_draft_event") return jsonResponse({ ok: true, eventInstance: await createDraftEventInstance(db, input, actor(access)) }, { status: 201 });
    if (action === "update_event_instance") return jsonResponse({ ok: true, eventInstance: await updateEventInstanceById(db, input.event_instance_id ?? input.eventInstanceId, input, actor(access)) });
    if (action === "create_template_version") return jsonResponse({ ok: true, templateVersion: await createTimelineTemplateVersion(db, input, actor(access)) }, { status: 201 });
    if (action === "instantiate") return jsonResponse({ ok: true, timeline: await instantiateEventPlan(db, input.event_instance_id ?? input.eventInstanceId, input.template_version_id ?? input.templateVersionId, actor(access)) }, { status: 201 });
    if (action === "create_anchor") return jsonResponse({ ok: true, anchor: await createPlanAnchor(db, input.event_plan_id ?? input.eventPlanId, input, actor(access)) }, { status: 201 });
    if (action === "create_item") return jsonResponse({ ok: true, item: await createPlanItem(db, input.event_plan_id ?? input.eventPlanId, input, actor(access)) }, { status: 201 });
    throw Object.assign(new Error("Unknown event-planning action."), { status: 400 });
  });
}

export async function onRequest(context) { return methodNotAllowed(["GET", "POST"]); }
