export async function onRequestPost(context) {
  try {
    const data = await context.request.json();

    const required = ["name", "email", "university", "year", "experience", "tshirt", "coc"];
    const missing = required.some((field) => !data[field]);
    if (missing) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      return new Response(JSON.stringify({ error: "Invalid email format" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const targetEmail =
      context.env.REGISTRATION_TO_EMAIL || "registrations@hackthevalley.com";
    const fromEmail =
      context.env.REGISTRATION_FROM_EMAIL || "noreply@hackthevalley.com";

    const escapeHtml = (value) =>
      String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    const safe = (value) =>
      value ? escapeHtml(String(value).trim()) : "Not provided";
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
      from: {
        email: fromEmail,
        name: "Hack the Valley Registrations"
      },
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

    // Always log a structured backup record so submissions are retained
    // even when outbound email is unavailable in local dev.
    console.log(
      "registration_backup_record",
      JSON.stringify({
        ...data,
        deliveredByEmail,
        receivedAt: new Date().toISOString()
      })
    );

    return new Response(
      JSON.stringify({
        success: true,
        deliveredByEmail,
        message: "Registration received"
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    console.error("Registration error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
