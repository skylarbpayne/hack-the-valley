import {
  addSignupToEmailList,
  checkInAttendee,
  getDb,
  getEvent,
  getEventInstance,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
  resolveSignupEventInstance,
  searchCheckinCandidates
} from "../../../../_lib/event-platform.js";

async function resolveCheckinInstance(db, eventSlug, requestedInstanceId) {
  if (requestedInstanceId) {
    const instance = await getEventInstance(db, eventSlug, requestedInstanceId);
    if (!instance) throw Object.assign(new Error("Event instance not found"), { status: 404 });
    return instance;
  }
  const instance = await resolveSignupEventInstance(db, eventSlug);
  if (!instance) throw Object.assign(new Error("No open instance is available for this event"), { status: 409 });
  return instance;
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const event = await getEvent(db, context.params.slug);
    if (!event || event.status === "archived") return jsonResponse({ error: "Event not found" }, { status: 404 });

    const url = new URL(context.request.url);
    const instance = await resolveCheckinInstance(db, context.params.slug, url.searchParams.get("instance_id"));
    const query = url.searchParams.get("query") || url.searchParams.get("q") || "";
    const candidates = await searchCheckinCandidates(db, context.params.slug, {
      eventInstanceId: instance.id,
      query,
      limit: url.searchParams.get("limit") || 25
    });

    return jsonResponse({ event, instance, candidates, count: candidates.length });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const event = await getEvent(db, context.params.slug);
    if (!event || event.status === "archived") return jsonResponse({ error: "Event not found" }, { status: 404 });

    const url = new URL(context.request.url);
    const input = await readJson(context.request);
    const instance = await resolveCheckinInstance(db, context.params.slug, input.event_instance_id || url.searchParams.get("instance_id"));

    const result = await checkInAttendee(db, event, input, {
      eventInstance: instance,
      actor: input.actor || "admin",
      source: "admin-checkin",
      syncEmailList: (signup) => addSignupToEmailList(context.env, signup, event)
    });

    return jsonResponse({
      success: true,
      event: { slug: event.slug, title: event.title },
      instance: { id: instance.id, instance_key: instance.instance_key, starts_at: instance.starts_at },
      signup: {
        id: result.signup.id,
        event_instance_id: result.signup.event_instance_id,
        user_id: result.signup.user_id,
        name: result.signup.name,
        email: result.signup.email,
        checked_in_at: result.checked_in_at,
        mailing_list_status: result.signup.mailing_list_status
      }
    }, { status: 201 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
