import {
  addSignupToEmailList,
  getDb,
  getEvent,
  handleErrors,
  jsonResponse,
  normalizeSignupInput,
  readJson,
  upsertSignup
} from "../_lib/event-platform.js";

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const input = await readJson(context.request);
    const eventSlug = input.eventSlug || input.event_slug || context.env.HTV_DEFAULT_EVENT_SLUG || context.env.DEFAULT_EVENT_SLUG;

    // New path: event-aware signup processing + Resend list sync.
    // Legacy path remains below so an old /api/register caller does not break before D1 is configured.
    if (eventSlug && (context.env.HTV_DB || context.env.SUBMISSIONS_DB || context.env.DB)) {
      const db = getDb(context.env);
      const event = await getEvent(db, eventSlug);
      if (!event || event.status === "archived") {
        return jsonResponse({ error: "Event not found" }, { status: 404 });
      }
      if (event.status !== "open") {
        return jsonResponse({ error: "Signups are not open for this event" }, { status: 409 });
      }

      const { signup, errors } = normalizeSignupInput(input, eventSlug);
      if (errors.length) {
        return jsonResponse({ error: errors.join("; "), errors }, { status: 400 });
      }

      const mailingListResult = await addSignupToEmailList(context.env, signup, event);
      const savedSignup = await upsertSignup(db, eventSlug, input, mailingListResult);

      return jsonResponse({
        success: true,
        message: "Signup received",
        event: { slug: event.slug, title: event.title },
        signup: {
          id: savedSignup.id,
          user_id: savedSignup.user_id,
          name: savedSignup.name,
          email: savedSignup.email,
          mailing_list_status: savedSignup.mailing_list_status
        }
      }, { status: 201 });
    }

    return legacyRegistrationNotification(context, input);
  });
}

async function legacyRegistrationNotification(context, data) {
  const required = ["name", "email", "university", "year", "experience", "tshirt", "coc"];
  const missing = required.some((field) => !data[field]);
  if (missing) {
    return jsonResponse({ error: "Missing required fields" }, { status: 400 });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(data.email)) {
    return jsonResponse({ error: "Invalid email format" }, { status: 400 });
  }

  const targetEmail = context.env.REGISTRATION_TO_EMAIL || "registrations@hackthevalley.com";
  const fromEmail = context.env.REGISTRATION_FROM_EMAIL || "noreply@hackthevalley.com";

  const safe = (value) => value ? escapeHtml(String(value).trim()) : "Not provided";
  const htmlBody = `
    <h2>New Hack the Valley Registration</h2>
    <p><strong>Name:</strong> ${safe(data.name)}</p>
    <p><strong>Email:</strong> ${safe(data.email)}</p>
    <p><strong>University:</strong> ${safe(data.university)}</p>
    <p><strong>Year:</strong> ${safe(data.year)}</p>
    <p><strong>Major:</strong> ${safe(data.major)}</p>
    <p><strong>Experience Level:</strong> ${safe(data.experience)}</p>
    <p><strong>Dietary:</strong> ${safe(data.dietary)}</p>
    <p><strong>T-Shirt:</strong> ${safe(data.tshirt)}</p>
    <p><strong>Agreed to CoC:</strong> ${data.coc ? "Yes" : "No"}</p>
    <p><strong>Submitted:</strong> ${safe(data.timestamp)}</p>
  `;

  const emailPayload = {
    personalizations: [{ to: [{ email: targetEmail }] }],
    from: { email: fromEmail, name: "Hack the Valley Registrations" },
    reply_to: { email: safe(data.email) },
    subject: `New registration: ${safe(data.name)}`,
    content: [{ type: "text/html", value: htmlBody }]
  };

  let deliveredByEmail = false;
  try {
    const emailResponse = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emailPayload)
    });
    if (emailResponse.ok) {
      deliveredByEmail = true;
    } else {
      const errorText = await emailResponse.text();
      console.error("Mail send failed:", errorText);
    }
  } catch (mailError) {
    console.error("Mail send exception:", mailError);
  }

  console.log("registration_backup_record", JSON.stringify({
    ...data,
    deliveredByEmail,
    receivedAt: new Date().toISOString()
  }));

  return jsonResponse({
    success: true,
    deliveredByEmail,
    message: "Registration received"
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
