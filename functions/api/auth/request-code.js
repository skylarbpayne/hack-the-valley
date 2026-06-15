import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requestLoginCode
} from "../../_lib/event-platform.js";

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const body = await readJson(context.request);
    const requestUrl = new URL(context.request.url);
    const result = await requestLoginCode(getDb(context.env), body, {
      ...context.env,
      HTV_PUBLIC_BASE_URL: context.env.HTV_PUBLIC_BASE_URL || requestUrl.origin
    });
    return jsonResponse(result);
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["POST"]);
}
