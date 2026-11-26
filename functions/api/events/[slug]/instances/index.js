import { getDb, handleErrors, jsonResponse, methodNotAllowed, readJson, requireOrganizerAccess } from '../../../../_lib/event-platform.js';
import { createOrganizerInstance } from '../../../../_lib/domain/events.js';

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const access = await requireOrganizerAccess(context.request, context.env, { scopeType: 'event', scopeId: context.params.slug });
    const instance = await createOrganizerInstance(getDb(context.env), context.params.slug, await readJson(context.request), access);
    return jsonResponse({ instance }, { status: 201 });
  });
}
export async function onRequest(context) { return methodNotAllowed(['POST']); }
