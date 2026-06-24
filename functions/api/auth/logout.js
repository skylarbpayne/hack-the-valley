import {
  clearSessionCookie,
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  revokeSessionByToken
} from "../../_lib/event-platform.js";

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!match) return "";
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return match.slice(name.length + 1);
  }
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const token = cookieValue(context.request, "htv_session") || context.request.headers.get("x-htv-session") || "";
    if (token) await revokeSessionByToken(getDb(context.env), token);
    const response = jsonResponse({ ok: true });
    response.headers.set("Set-Cookie", clearSessionCookie());
    return response;
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["POST"]);
}
