import {
  getDb,
  handleErrors,
  sessionCookie,
  verifyLoginToken
} from "../../_lib/event-platform.js";

function safeNextPath(value) {
  const fallback = "/me/";
  let next = String(value || "").trim();
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  for (let i = 0; i < 2; i += 1) {
    if (/[\\\u0000-\u001f\u007f]/.test(next) || next.startsWith("//")) return fallback;
    try {
      const decoded = decodeURIComponent(next);
      if (decoded === next) break;
      next = decoded;
    } catch {
      break;
    }
  }
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  return next;
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
