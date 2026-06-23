import {
  addSignupToEmailList,
  applySignupRole,
  getCurrentUserFromRequest,
  getDb,
  getEvent,
  handleErrors,
  jsonResponse,
  listSignups,
  methodNotAllowed,
  normalizeParticipationInput,
  readJson,
  registerParticipation,
  requireAdmin,
  resolveSignupEventInstance,
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
    const event = await getEvent(db, context.params.slug);
    if (!event || event.status === "archived") {
      return jsonResponse({ error: "Event not found" }, { status: 404 });
    }
    if (event.status !== "open") {
      return jsonResponse({ error: "Signups are not open for this event" }, { status: 409 });
    }

    const instance = await resolveSignupEventInstance(db, context.params.slug);
    if (!instance) {
      return jsonResponse({ error: "No open instance is available for this event" }, { status: 409 });
    }

    const currentUser = await getCurrentUserFromRequest(db, context.request);
    const rawInput = await readJson(context.request);
    const roleInput = applySignupRole(rawInput, event);
    const input = roleInput.input;
    const participation = normalizeParticipationInput(input, event, currentUser);
    const allErrors = [...roleInput.errors, ...participation.errors];
    if (allErrors.length) {
      return jsonResponse({ error: allErrors.join("; "), errors: allErrors }, { status: 400 });
    }

    const mailingListResult = await addSignupToEmailList(context.env, participation.signup, event);
    const registration = await registerParticipation(db, {
      person: participation.person,
      eventSeries: event,
      eventInstance: instance,
      eventRole: participation.eventRole,
      safetyInput: participation.safetyInput,
      source: currentUser ? "signed-in-event-signup" : "signup-api",
      signup: participation.signup,
      mailingListResult
    });
    const savedSignup = registration.signup;

    return jsonResponse({
      success: true,
      message: "Signup received",
      event: { slug: event.slug, title: event.title },
      readiness: registration.readiness,
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
