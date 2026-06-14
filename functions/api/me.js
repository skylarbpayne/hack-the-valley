import {
  getCurrentUserFromSession,
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed
} from "../_lib/event-platform.js";

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const token = cookieValue(context.request, "htv_session") || context.request.headers.get("x-htv-session") || "";
    const user = await getCurrentUserFromSession(getDb(context.env), token);
    if (!user) return jsonResponse({ ok: false, error: "Not signed in" }, { status: 401 });
    return jsonResponse({ ok: true, user });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
