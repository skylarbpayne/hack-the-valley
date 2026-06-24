import {
  getDb,
  getPublicProjectHeroMedia,
  handleErrors,
  methodNotAllowed
} from "../../_lib/event-platform.js";
import { errorResponse, optionsResponse } from "../../_shared/submissions.js";

export function onRequestOptions() {
  return optionsResponse();
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const url = new URL(context.request.url);
    const eventSlug = url.searchParams.get("event") || context.env.HTV_DEFAULT_PROJECT_EVENT_SLUG || "hack-the-valley-2026";
    const projectSlug = url.searchParams.get("project") || "";
    if (!projectSlug) return errorResponse("Project is required.", 400);
    if (!context.env.SUBMISSIONS_MEDIA) return errorResponse("Project media storage is not configured.", 503);

    const media = await getPublicProjectHeroMedia(getDb(context.env), { eventSlug, projectSlug });
    if (!media?.key) return errorResponse("Project media not found.", 404);

    const object = await context.env.SUBMISSIONS_MEDIA.get(media.key);
    if (!object) return errorResponse("Project media not found.", 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=3600");
    headers.set("x-content-type-options", "nosniff");
    headers.set("content-disposition", `inline; filename="${String(media.filename || media.originalFilename || "project-media").replace(/["\\]/g, "")}"`);
    return new Response(object.body, { headers });
  });
}

export async function onRequest() {
  return methodNotAllowed(["GET", "OPTIONS"]);
}
