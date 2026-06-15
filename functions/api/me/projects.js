import {
  claimProjectForUser,
  getCurrentUserFromSession,
  getDb,
  getUserCommunityState,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson
} from "../../_lib/event-platform.js";

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

async function signedInUser(context) {
  const db = getDb(context.env);
  const token = cookieValue(context.request, "htv_session") || context.request.headers.get("x-htv-session") || "";
  const user = await getCurrentUserFromSession(db, token);
  if (!user) throw Object.assign(new Error("Not signed in"), { status: 401 });
  return { db, user };
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const { db, user } = await signedInUser(context);
    const input = await readJson(context.request);
    const claimed = await claimProjectForUser(db, user.id, input);
    const state = await getUserCommunityState(db, user.id);
    return jsonResponse({ ok: true, ...claimed, state }, { status: 200 });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["POST"]);
}
