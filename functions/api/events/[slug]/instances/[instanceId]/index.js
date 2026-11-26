import { getDb, handleErrors, jsonResponse, methodNotAllowed, readJson, requireOrganizerAccess } from '../../../../../_lib/event-platform.js';
import { setOrganizerInstanceStatus } from '../../../../../_lib/domain/events.js';

export async function onRequestPatch(context) {
  return handleErrors(async () => {
    const access = await requireOrganizerAccess(context.request, context.env, { scopeType: 'event', scopeId: context.params.slug });
    const instance = await setOrganizerInstanceStatus(getDb(context.env), context.params.slug, context.params.instanceId, await readJson(context.request), access);
    return jsonResponse({ instance });
  });
}
export async function onRequest(context) { return methodNotAllowed(['PATCH']); }
