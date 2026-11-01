import {
  checkInEventAttendee,
  getDb,
  handleErrors,
  jsonResponse,
  listEventCheckinCandidates,
  methodNotAllowed,
  readJson,
  requireOrganizerAccess
} from "../../../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const access = await requireOrganizerAccess(context.request, context.env, { scopeType: "event", scopeId: context.params.slug });
    const db = getDb(context.env);
    const url = new URL(context.request.url);
    const query = url.searchParams.get("query") || url.searchParams.get("q") || "";
    const { event, instance, candidates } = await listEventCheckinCandidates(db, context.params.slug, {
      requestedInstanceId: url.searchParams.get("instance_id"),
      query,
      limit: url.searchParams.get("limit") || 25,
      signedUpOnly: access.role?.role === "organizer"
    });

    return jsonResponse({ event, instance, candidates, count: candidates.length });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = await requireOrganizerAccess(context.request, context.env, { scopeType: "event", scopeId: context.params.slug });
    const db = getDb(context.env);
    const url = new URL(context.request.url);
    const input = await readJson(context.request);
    if (access.role?.role === "organizer") {
      const instanceId = input.event_instance_id || url.searchParams.get("instance_id");
      const existing = typeof input.user_id === 'string' && typeof instanceId === 'string'
        ? await db.prepare('SELECT id FROM signups WHERE event_slug=? AND event_instance_id=? AND user_id=?').bind(context.params.slug, instanceId, input.user_id).first()
        : null;
      if (!existing || Object.keys(input).some(key => !['user_id', 'event_instance_id'].includes(key))) {
        return jsonResponse({ error: "Organizers can only check in existing event signups." }, { status: 403 });
      }
    }
    const result = await checkInEventAttendee(db, context.env, context.params.slug, input, {
      requestedInstanceId: input.event_instance_id || url.searchParams.get("instance_id"),
      actor: access.user?.id || "admin"
    });
    const { event, instance } = result;

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
        already_checked_in: result.already_checked_in,
        mailing_list_status: result.signup.mailing_list_status
      }
    }, { status: 201 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
