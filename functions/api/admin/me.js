import {
  getUserCommunityState,
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
    const access = await requireAdmin(context.request, context.env);
    if (access.bootstrap) {
      return jsonResponse({
        ok: true,
        bootstrap: true,
        user: null,
        roles: [{ role: "bootstrap", scope_type: "global", scope_id: "*" }],
        capabilities: {
          admin: true,
          super_admin: true,
          role_management: true,
          bootstrap: true
        }
      });
    }

    const state = await getUserCommunityState(context.env.HTV_DB || context.env.SUBMISSIONS_DB || context.env.DB, access.user.id);
    const roles = state.roles || [];
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
        super_admin: isSuperAdmin(roles),
        role_management: isSuperAdmin(roles),
        bootstrap: false
      }
    });
  });
}

export async function onRequest(context) {
  return methodNotAllowed(["GET"]);
}
