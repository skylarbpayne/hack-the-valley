import {
  getUserCommunityState,
  getCurrentUserFromRequest,
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin
} from "../../_lib/event-platform.js";

function isSuperAdmin(roles = []) {
  return roles.some((role) => role.role === "super_admin" && !role.revoked_at);
}

function isAdmin(roles = []) {
  return roles.some((role) => ["admin", "super_admin"].includes(role.role) && !role.revoked_at);
}

export async function onRequestGet(context) {
  return handleErrors(async () => {
    const db = getDb(context.env);
    const signedIn = await getCurrentUserFromRequest(db, context.request);
    const access = signedIn ? { user: signedIn, bootstrap: false } : await requireAdmin(context.request, context.env);
    if (access.bootstrap) {
      return jsonResponse({
        ok: true,
        bootstrap: true,
        user: null,
        roles: [{ role: "bootstrap", scope_type: "global", scope_id: "*" }],
        capabilities: {
          admin: true,
          super_admin: true,
          role_management: false,
          bootstrap: true
        }
      });
    }

    const state = await getUserCommunityState(db, access.user.id);
    const roles = state.roles || [];
    if (!roles.some(role => ['admin', 'super_admin', 'organizer'].includes(role.role) && !role.revoked_at)) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 });
    }
    return jsonResponse({
      ok: true,
      bootstrap: false,
      user: {
        ...state.user,
        session_id: access.user.session_id,
        session_expires_at: access.user.session_expires_at
      },
      roles,
      capabilities: {
        admin: isAdmin(roles),
        organizer: roles.some((role) => role.role === "organizer" && !role.revoked_at),
        super_admin: isSuperAdmin(roles),
        role_management: roles.some(role => role.role === "super_admin" && role.scope_type === "global" && role.scope_id === "*" && !role.revoked_at),
        bootstrap: false
      }
    });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
