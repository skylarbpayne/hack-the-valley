import { getDb, handleErrors, jsonResponse, methodNotAllowed, readJson, requireAdmin } from "../../../_lib/event-platform.js";
import {
  applyAnchorShift, assignPlanItem, attachPlanEvidence, blockPlanItem, completePlanItem,
  createPlanDependency, getEventPlanTimeline, previewAnchorShift, removePlanDependency,
  reopenPlanItem, reschedulePlanItem, unblockPlanItem
} from "../../../_lib/domain/event-planning.js";

function requireSessionAdmin(access) {
  if (access?.bootstrap || !access?.user?.id) throw Object.assign(new Error("A signed-in admin session is required."), { status: 403 });
  return access;
}
function actor(access) { return { userId: access.user.id }; }

export async function onRequestGet(context) {
  return handleErrors(async () => {
    requireSessionAdmin(await requireAdmin(context.request, context.env));
    const timeline = await getEventPlanTimeline(getDb(context.env), context.params.id);
    if (!timeline) throw Object.assign(new Error("Event plan not found"), { status: 404 });
    return jsonResponse({ ok: true, timeline });
  });
}

export async function onRequestPatch(context) {
  return handleErrors(async () => {
    const access = requireSessionAdmin(await requireAdmin(context.request, context.env));
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const action = String(input.action || "").trim();
    const planId = context.params.id;
    if (action === "preview_anchor_shift") return jsonResponse({ ok: true, preview: await previewAnchorShift(db, planId, input) });
    if (action === "apply_anchor_shift") return jsonResponse({ ok: true, result: await applyAnchorShift(db, planId, input, actor(access)) });
    const itemId = input.item_id ?? input.itemId;
    if (action === "assign") await assignPlanItem(db, itemId, input, actor(access));
    else if (action === "reschedule") await reschedulePlanItem(db, itemId, input, actor(access));
    else if (action === "complete") await completePlanItem(db, itemId, actor(access));
    else if (action === "reopen") await reopenPlanItem(db, itemId, actor(access));
    else if (action === "block") await blockPlanItem(db, itemId, actor(access));
    else if (action === "unblock") await unblockPlanItem(db, itemId, actor(access));
    else if (action === "attach_evidence") await attachPlanEvidence(db, itemId, input, actor(access));
    else if (action === "add_dependency") await createPlanDependency(db, itemId, input.depends_on_item_id ?? input.dependsOnItemId, actor(access));
    else if (action === "remove_dependency") await removePlanDependency(db, itemId, input.depends_on_item_id ?? input.dependsOnItemId, actor(access));
    else throw Object.assign(new Error("Unknown event-planning action."), { status: 400 });
    return jsonResponse({ ok: true, timeline: await getEventPlanTimeline(db, planId) });
  });
}

export async function onRequest(context) { return methodNotAllowed(["GET", "PATCH"]); }
