import { getCurrentUserFromRequest, getDb, handleErrors, jsonResponse, methodNotAllowed } from '../_lib/event-platform.js';

// This is navigation, not authorization. Every destination retains its own API guard.
export async function onRequestGet({ request, env }) {
  return handleErrors(async () => {
    const db = getDb(env);
    const user = await getCurrentUserFromRequest(db, request);
    if (!user) return jsonResponse({ ok: false, error: 'Not signed in' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
    const [roleRows, vaultRow] = await Promise.all([
      db.prepare("SELECT role,scope_type,scope_id FROM roles WHERE user_id=? AND revoked_at IS NULL AND role IN ('organizer','admin','super_admin')").bind(user.id).all(),
      db.prepare("SELECT role FROM social_vault_members WHERE user_id=? AND revoked_at IS NULL AND role IN ('member','owner')").bind(user.id).first()
    ]);
    const roles = roleRows.results || [];
    const global = name => roles.some(row => row.role === name && row.scope_type === 'global' && row.scope_id === '*');
    const admin = global('admin') || global('super_admin');
    const globalOrganizer = admin || global('organizer');
    const events = [...new Set(roles.filter(row => row.role === 'organizer' && row.scope_type === 'event' && row.scope_id).map(row => row.scope_id))].sort();
    const organizer = globalOrganizer ? { scope: 'global', events: [] } : events.length ? { scope: 'event', events } : null;
    const socialVault = admin ? 'admin' : vaultRow?.role || null;
    const links = [
      { id: 'profile', title: 'Update profile', description: 'Your account and event details', href: '/me/' },
      { id: 'my-projects', title: 'Manage projects', description: 'Your submissions and materials', href: '/me/projects/' }
    ];
    if (organizer) links.push({ id: 'event-operations', title: 'Run events', description: globalOrganizer ? 'Events, check-in and photos' : `Assigned events: ${events.join(', ')}`, href: '/organizer' });
    if (globalOrganizer) links.push({ id: 'sponsorships', title: 'Manage sponsorships', description: 'Shared sponsorship workspace', href: '/admin-sponsorships' });
    if (socialVault) links.push({ id: 'shared-logins', title: 'Open shared logins', description: socialVault === 'member' ? 'Reveal shared social logins' : 'Manage shared social logins', href: '/shared-logins/' });
    if (admin) links.push({ id: 'site-admin', title: 'Open site admin', description: 'Site-wide administration', href: '/admin' });
    return jsonResponse({
      ok: true,
      user: { name: user.name, email: user.email },
      capabilities: { participant: true, organizer, social_vault: socialVault, admin, super_admin: global('super_admin') },
      links
    }, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  });
}

export async function onRequest() {
  return methodNotAllowed(['GET']);
}
