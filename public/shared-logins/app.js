const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
let state, timer;
async function api(path = '', method = 'GET', body) {
  const response = await fetch(`/api/social-vault${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function hideSecret() { clearTimeout(timer); document.querySelectorAll('[data-secret]').forEach(node => node.remove()); }
function button(text, action, className = '') { const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.className = className; el.addEventListener('click', action); return el; }
async function refresh() {
  hideSecret();
  state = await api();
  $('editor').hidden = state.role !== 'owner';
  $('management').hidden = state.role !== 'owner';
  const list = $('accounts'); list.replaceChildren();
  if (!state.accounts.length) { const empty = document.createElement('p'); empty.textContent = 'No accounts saved yet.'; list.append(empty); }
  for (const account of state.accounts) {
    const row = document.createElement('div'); row.className = 'row';
    const title = document.createElement('strong'); title.textContent = account.label;
    row.append(title, button('Reveal', async () => {
      hideSecret();
      try {
        const secret = await api(`/accounts/${account.id}/reveal`, 'POST');
        const detail = document.createElement('div'); detail.dataset.secret = 'true';
        const login = document.createElement('pre'); login.textContent = `Login: ${secret.login}`;
        const password = document.createElement('pre'); password.textContent = `Password: ${secret.password}`;
        detail.append(login, password, button('Hide now', hideSecret, 'secondary'));
        row.after(detail);
        timer = setTimeout(hideSecret, 30000);
        status('Shown temporarily; this reveal was audited.');
      } catch (error) { status(error.message); }
    }));
    if (state.role === 'owner') row.append(button('Replace', () => {
      hideSecret(); const form = $('account-form'); form.reset(); form.elements.id.value = account.id; form.elements.revision.value = account.revision; form.elements.label.value = account.label; form.elements.login.focus(); status('Enter the login and new password to replace this account.');
    }, 'secondary'));
    list.append(row);
  }
  if (state.role === 'owner') {
    const members = $('members'); members.replaceChildren(); $('count').textContent = `${state.members.length} of ${state.capacity} active people`;
    for (const member of state.members) {
      const row = document.createElement('div'); row.className = 'row';
      const name = document.createElement('span'); name.textContent = `${member.email} (${member.role})`;
      row.append(name, button('Revoke', async () => {
        if (!confirm(`Revoke ${member.email}? You must rotate passwords they could have seen.`)) return;
        try { const result = await api(`/members/${encodeURIComponent(member.user_id)}`, 'DELETE'); status(result.rotationWarning); await refresh(); status(result.rotationWarning); }
        catch (error) { status(error.message); }
      }, 'secondary')); members.append(row);
    }
  }
}
$('account-form').addEventListener('submit', async event => {
  event.preventDefault(); hideSecret(); const form = event.currentTarget, fields = form.elements;
  const id = fields.id.value, revision = Number(fields.revision.value);
  try { await api(id ? `/accounts/${id}` : '/accounts', id ? 'PUT' : 'POST', { label: fields.label.value, login: fields.login.value, password: fields.password.value, ...(id ? { revision } : {}) }); form.reset(); await refresh(); status('Encrypted login saved.'); }
  catch (error) { status(error.message); }
});
$('grant-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api('/members', 'POST', { email: form.elements.email.value, role: form.elements.role.value }); form.reset(); await refresh(); status('Access granted.'); }
  catch (error) { status(error.message); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) hideSecret(); });
window.addEventListener('pagehide', hideSecret);
refresh().catch(error => status(`${error.message} Sign in with your HTV account, then ask a vault owner for access.`));
