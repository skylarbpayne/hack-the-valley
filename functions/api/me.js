import {
  getCurrentUserFromSession,
  getDb,
  getUserCommunityState,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  updateUserProfile
} from "../_lib/event-platform.js";

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

async function signedInUser(context) {
  const db = getDb(context.env);
  const token = cookieValue(context.request, "htv_session") || context.request.headers.get("x-htv-session") || "";
  const user = await getCurrentUserFromSession(db, token);
  if (!user) return { db, user: null };
  return { db, user };
}

function stateResponse(state, sessionUser) {
  return jsonResponse({
    ok: true,
    ...state,
    user: {
      ...state.user,
      session_id: sessionUser.session_id,
      session_expires_at: sessionUser.session_expires_at
    }
  });
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const { db, user } = await signedInUser(context);
    if (!user) return jsonResponse({ ok: false, error: "Not signed in" }, { status: 401 });
    const state = await getUserCommunityState(db, user.id);
    return stateResponse(state, user);
  });
}

export async function onRequestPatch(context) {
  return handleErrors(async () => {
    const { db, user } = await signedInUser(context);
    if (!user) return jsonResponse({ ok: false, error: "Not signed in" }, { status: 401 });
    const input = await readJson(context.request);
    await updateUserProfile(db, user.id, input);
    const state = await getUserCommunityState(db, user.id);
    return stateResponse(state, user);
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "PATCH"]);
}
