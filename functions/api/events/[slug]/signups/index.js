import {
  getCurrentUserFromRequest,
  getDb,
  getEvent,
  handleErrors,
  jsonResponse,
  listSignups,
  methodNotAllowed,
  readJson,
  registerEventSignup,
  requireAdmin,
  signupsToCsv
} from "../../../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const event = await getEvent(db, context.params.slug);
    if (!event) return jsonResponse({ error: "Event not found" }, { status: 404 });
    const url = new URL(context.request.url);
    const instanceId = url.searchParams.get("instance_id");
    const signups = await listSignups(db, context.params.slug, { eventInstanceId: instanceId });
    if (url.searchParams.get("format") === "csv") {
      return new Response(signupsToCsv(signups), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${context.params.slug}-signups.csv"`,
          "Cache-Control": "no-store"
        }
      });
    }
    return jsonResponse({ event, signups, count: signups.length });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const db = getDb(context.env);
    const currentUser = await getCurrentUserFromRequest(db, context.request);
    const rawInput = await readJson(context.request);
    const registration = await registerEventSignup(db, context.env, context.params.slug, rawInput, { currentUser });
    const event = registration.event;
    const participation = registration.input;
    const savedSignup = registration.signup;

    const needsProfileCompletion = Boolean(registration.readiness && registration.readiness.ready === false);
    const profileCompletionUrl = `/me/?next=${encodeURIComponent(`/events/${encodeURIComponent(event.slug)}#signup`)}`;

    return jsonResponse({
      success: true,
      message: "Signup received",
      event: { slug: event.slug, title: event.title },
      readiness: registration.readiness,
      profile_completion: needsProfileCompletion ? {
        required: true,
        code: "missing_safety_contact",
        url: profileCompletionUrl,
        message: "Add emergency contact details to your profile before event check-in."
      } : { required: false },
      signup: {
        id: savedSignup.id,
        event_instance_id: savedSignup.event_instance_id,
        signup_role: participation.eventRole,
        user_id: savedSignup.user_id,
        signed_in: Boolean(currentUser),
        name: savedSignup.name,
        email: savedSignup.email,
        mailing_list_status: savedSignup.mailing_list_status,
        emergency_contact_present: Boolean(registration.readiness?.safety_contact_present)
      }
    }, { status: 201 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
