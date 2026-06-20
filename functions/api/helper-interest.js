import {
  createHelperInterest,
  getCurrentUserFromSession,
  getDb,
  handleErrors,
  jsonResponse,
  listHelperInterests,
  methodNotAllowed,
  readJson,
  requireAdmin
} from "../_lib/event-platform.js";

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

async function optionalSessionUser(db, request) {
  const token = cookieValue(request, "htv_session") || request.headers.get("x-htv-session") || "";
  return await getCurrentUserFromSession(db, token);
}

function publicHelperInterestResponse(saved) {
  return {
    id: saved.id,
    role_interest: saved.role_interest,
    status: saved.status,
    created_at: saved.created_at
  };
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const db = getDb(context.env);
    const input = await readJson(context.request);
    const currentUser = await optionalSessionUser(db, context.request);
    const saved = await createHelperInterest(db, input, currentUser);

    return jsonResponse({
      success: true,
      message: "Thanks — your interest has been saved for the organizers.",
      helper_interest: publicHelperInterestResponse(saved)
    }, { status: 201 });
  });
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const url = new URL(context.request.url);
    const interests = await listHelperInterests(getDb(context.env), {
      limit: url.searchParams.get("limit") || 200,
      status: url.searchParams.get("status")
    });
    return jsonResponse({ helper_interests: interests, count: interests.length });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET", "POST"]);
}
