import {
  addSignupToEmailList,
  getDb,
  getEvent,
  handleErrors,
  jsonResponse,
  listSignups,
  methodNotAllowed,
  normalizeSignupInput,
  readJson,
  requireAdmin,
  signupsToCsv,
  upsertSignup
} from "../../../../_lib/event-platform.js";

export async function onRequestGet(context) {
  return handleErrors(async () => {
    requireAdmin(context.request, context.env);
    const db = getDb(context.env);
    const event = await getEvent(db, context.params.slug);
    if (!event) return jsonResponse({ error: "Event not found" }, { status: 404 });
    const signups = await listSignups(db, context.params.slug);
    const url = new URL(context.request.url);
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

    const input = await readJson(context.request);
    const { signup, errors } = normalizeSignupInput(input, context.params.slug);
    if (errors.length) {
      return jsonResponse({ error: errors.join("; "), errors }, { status: 400 });
    }

    const mailingListResult = await addSignupToEmailList(context.env, signup, event);
    const savedSignup = await upsertSignup(db, context.params.slug, input, mailingListResult);

    return jsonResponse({
      success: true,
      message: "Signup received",
      event: { slug: event.slug, title: event.title },
      signup: {
        id: savedSignup.id,
        name: savedSignup.name,
        email: savedSignup.email,
        mailing_list_status: savedSignup.mailing_list_status
      }
    }, { status: 201 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
