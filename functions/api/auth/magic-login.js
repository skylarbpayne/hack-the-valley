import {
  getDb,
  handleErrors,
  sessionCookie,
  verifyLoginToken
} from "../../_lib/event-platform.js";

function safeNextPath(value) {
  const next = String(value || "").trim();
  return next.startsWith("/") && !next.startsWith("//") ? next : "/me/";
}

function redirectWithMessage(request, message) {
  const url = new URL("/login/", request.url);
  url.searchParams.set("error", message);
  return Response.redirect(url, 302);
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const url = new URL(context.request.url);
    const token = url.searchParams.get("token") || "";
    if (!token) return redirectWithMessage(context.request, "invalid-link");

    const result = await verifyLoginToken(getDb(context.env), {
      token,
      user_agent: context.request.headers.get("user-agent") || null,
      ip_hint: context.request.headers.get("cf-connecting-ip") || null
    }, context.env);

    const redirectUrl = new URL(safeNextPath(url.searchParams.get("next")), url.origin);
    const response = new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl.toString(),
        "Set-Cookie": sessionCookie(result.session.token, result.session.expires_at),
        "Cache-Control": "no-store"
      }
    });
    return response;
  });
}

export async function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
}
