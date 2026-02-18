export async function onRequestPost(context) {
  try {
    const data = await context.request.json();

    const required = ["name", "email", "university", "year", "tshirt", "coc"];
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

    console.log("New registration:", JSON.stringify(data));

    return new Response(JSON.stringify({ success: true, message: "Registration received" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("Registration error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
