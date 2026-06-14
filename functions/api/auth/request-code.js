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
    const result = await requestLoginCode(getDb(context.env), body, context.env);
    return jsonResponse(result);
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["POST"]);
}
