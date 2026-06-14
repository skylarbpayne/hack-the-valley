import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  sessionCookie,
  verifyLoginCode
} from "../../_lib/event-platform.js";

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const body = await readJson(context.request);
    const result = await verifyLoginCode(getDb(context.env), {
      ...body,
      user_agent: context.request.headers.get("user-agent") || null,
      ip_hint: context.request.headers.get("cf-connecting-ip") || null
    }, context.env);
    const response = jsonResponse({ ok: true, user: result.user, session: { id: result.session.id, expires_at: result.session.expires_at } });
    response.headers.set("Set-Cookie", sessionCookie(result.session.token, result.session.expires_at));
    return response;
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["POST"]);
}
