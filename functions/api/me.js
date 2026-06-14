import {
  getCurrentUserFromSession,
  getDb,
  getUserCommunityState,
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
    const db = getDb(context.env);
    const token = cookieValue(context.request, "htv_session") || context.request.headers.get("x-htv-session") || "";
    const user = await getCurrentUserFromSession(db, token);
    if (!user) return jsonResponse({ ok: false, error: "Not signed in" }, { status: 401 });
    const state = await getUserCommunityState(db, user.id);
    return jsonResponse({
      ok: true,
      ...state,
      user: {
        ...state.user,
        session_id: user.session_id,
        session_expires_at: user.session_expires_at
      }
    });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
