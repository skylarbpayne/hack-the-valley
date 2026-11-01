const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
const selected = () => $('event').value;
let events = [];
const path = slug => `/api/events/${encodeURIComponent(slug)}`;
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || data.errors?.join(', ') || `Request failed (${response.status})`);
  return data;
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const local = iso => iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0,16) : '';
const instant = value => value ? new Date(value).toISOString() : null;
function eventRecord() { return events.find(event => event.slug === selected()); }
const instanceId = () => $('instance-select').value;
async function refreshPhotos() {
  $('roster').replaceChildren(); $('photos').replaceChildren();
  const id = instanceId();
  $('instance').textContent = id ? 'Check-in and photos apply to the selected event date.' : 'No event instance; check-in and photos need one.';
  if (!id) return;
  const result = await api(`${path(selected())}/instances/${encodeURIComponent(id)}/photos`);
  for (const photo of result.photos || []) {
    const row = document.createElement('article'); row.textContent = photo.original_filename || photo.id; $('photos').append(row);
  }
}
async function refreshEvent() {
  const event = (await api(path(selected()))).event;
  const form = $('update');
  for (const key of ['title','description','status','venue_name']) form.elements[key].value = event[key] || '';
  for (const key of ['starts_at','ends_at']) form.elements[key].value = local(event[key]);
  const selector = $('instance-select'), previous = selector.value;
  selector.replaceChildren();
  const instances = eventRecord()?.instances || [];
  for (const instance of instances) {
    const option = document.createElement('option'); option.value = instance.id;
    option.textContent = `${instance.starts_at ? new Date(instance.starts_at).toLocaleString() : instance.instance_key} · ${instance.status}`;
    selector.append(option);
  }
  selector.value = instances.some(instance => instance.id === previous) ? previous : (event.active_instance_id || instances[0]?.id || '');
  await refreshPhotos();
}
async function init() {
  const me = await api('/api/admin/me');
  const roles = me.roles || [];
  $('full-admin-link').hidden = !me.capabilities?.admin;
  if (!roles.some(role => ['organizer','admin','super_admin'].includes(role.role) && !role.revoked_at)) throw Error('An active organizer or admin role is required.');
  const all = (await api('/api/events?include_archived=1')).events || [];
  const global = roles.some(role => ['organizer','admin','super_admin'].includes(role.role) && role.scope_type === 'global' && role.scope_id === '*' && !role.revoked_at);
  events = all.filter(event => event.status !== 'archived' && (global || roles.some(role => role.role === 'organizer' && role.scope_type === 'event' && role.scope_id === event.slug && !role.revoked_at)));
  if (!events.length) throw Error('No event is assigned to this account.');
  for (const event of events) { const option = document.createElement('option'); option.value = event.slug; option.textContent = event.title; $('event').append(option); }
  $('workspace').hidden = false;
  await refreshEvent(); status('Ready.');
}
$('event').addEventListener('change', () => refreshEvent().catch(error => status(error.message)));
$('instance-select').addEventListener('change', () => refreshPhotos().catch(error => status(error.message)));
$('update').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  const body = Object.fromEntries(['title','description','status','venue_name'].map(key => [key, form.elements[key].value]));
  for (const key of ['starts_at','ends_at']) body[key] = instant(form.elements[key].value);
  try { await api(path(selected()), json('PATCH', body)); status('Event saved.'); await refreshEvent(); } catch (error) { status(error.message); }
});
$('search').addEventListener('submit', async event => {
  event.preventDefault(); const container = $('roster'); container.replaceChildren();
  try {
    const id = instanceId();
    if (!id) throw Error('Select an event date first.');
    const query = event.currentTarget.elements.query.value;
    const data = await api(`${path(selected())}/checkins?query=${encodeURIComponent(query)}&instance_id=${encodeURIComponent(id)}`);
    for (const person of data.candidates || []) {
      const row = document.createElement('article');
      const label = document.createElement('span'); label.textContent = `${person.name || ''} · ${person.email || ''} ${person.checked_in_at ? '(checked in)' : ''}`;
      const action = document.createElement('button'); action.type = 'button'; action.textContent = 'Check in'; action.disabled = Boolean(person.checked_in_at);
      action.addEventListener('click', async () => { try { await api(`${path(selected())}/checkins`, json('POST', { user_id: person.id, event_instance_id: id })); action.disabled = true; status('Checked in.'); } catch (error) { status(error.message); } });
      row.append(label, action); container.append(row);
    }
    if (!data.candidates?.length) status('No matching signups.');
  } catch (error) { status(error.message); }
});
$('upload').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, file = form.elements.photo.files[0], id = instanceId();
  if (!id) { status('Select an event date first.'); return; }
  try {
    await api(`${path(selected())}/instances/${encodeURIComponent(id)}/photos?filename=${encodeURIComponent(file.name)}&kind=photo`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    form.reset(); await refreshEvent(); status('Photo uploaded.');
  } catch (error) { status(error.message); }
});
init().catch(error => status(`${error.message} Sign in at /login/?next=/organizer to continue.`));
