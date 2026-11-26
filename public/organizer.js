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
const pacific = value => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw Error('Enter a Pacific date and time.');
  const wall = Date.parse(`${value}:00Z`);
  const offset = date => {
    const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' }).formatToParts(date).find(part => part.type === 'timeZoneName').value;
    const match = zone.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!match) throw Error('Pacific timezone could not be resolved.');
    return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] || 0));
  };
  let time = wall - offset(new Date(wall)) * 60000;
  time = wall - offset(new Date(time)) * 60000;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(time));
  const part = name => parts.find(item => item.type === name)?.value;
  if (`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}` !== value)
    throw Error('That Pacific time does not exist (daylight-saving change).');
  return new Date(time).toISOString();
};
function eventRecord() { return events.find(event => event.slug === selected()); }
const instanceId = () => $('instance-select').value;
async function refreshPhotos() {
  $('roster').replaceChildren(); $('photos').replaceChildren();
  const id = instanceId();
  const current = eventRecord()?.instances?.find(instance => instance.id === id);
  $('instance').textContent = current ? `${current.instance_key} · ${current.status} · Check-in and photos apply to this selected date.` : 'No event instance; check-in and photos need one.';
  for (const button of $('instance-status').querySelectorAll('button')) button.disabled = !current || current.status === button.value;
  if (!id) return;
  const result = await api(`${path(selected())}/instances/${encodeURIComponent(id)}/photos`);
  for (const photo of result.photos || []) {
    const row = document.createElement('article'); row.textContent = photo.original_filename || photo.id; $('photos').append(row);
  }
}
async function refreshEvent() {
  const event = (await api(path(selected()))).event;
  const form = $('update');
  for (const key of ['title','description']) form.elements[key].value = event[key] || '';
  const updated = (await api('/api/events?include_archived=1')).events.find(row => row.slug === selected());
  if (updated) events = events.map(row => row.slug === updated.slug ? updated : row);
  const newForm = $('new-instance');
  for (const key of ['venue_name','venue_address','capacity','description']) newForm.elements[key].value = event[key] ?? '';
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
$('instance-status').addEventListener('submit', async event => {
  event.preventDefault();
  const id = instanceId(), next = event.submitter?.value;
  if (!id || !['open','closed'].includes(next)) return;
  const record = eventRecord();
  if (next === 'open' && record.instances.some(row => row.status === 'open' && row.id !== id)) { status('Close the current open date first.'); return; }
  if (!confirm(`${next === 'closed' ? 'Close' : 'Open'} ${record.instances.find(row => row.id === id)?.instance_key} for ${record.title}?`)) return;
  try {
    await api(`${path(selected())}/instances/${encodeURIComponent(id)}`, json('PATCH', { status: next, image_url: null }));
    await refreshEvent(); status(`${next === 'closed' ? 'Closed' : 'Opened'} selected date. Check the public page before sharing.`);
  } catch (error) { status(error.message); }
});
$('new-instance').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try {
    const body = Object.fromEntries(new FormData(form).entries());
    body.starts_at = pacific(body.starts_at); body.ends_at = pacific(body.ends_at);
    body.capacity = Number(body.capacity); body.image_url = null;
    if (body.status === 'open' && eventRecord().instances.some(row => row.status === 'open')) throw Error('Close the current open date first.');
    if (!confirm(`Create ${body.status} date ${body.starts_at} for ${eventRecord().title}? The public URL remains /events/${selected()}/.`)) return;
    const result = await api(`${path(selected())}/instances`, json('POST', body));
    await refreshEvent(); $('instance-select').value = result.instance.id; await refreshPhotos();
    status('Date created. Check the public page and active signup before sharing.');
  } catch (error) { status(error.message); }
});
$('update').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  const body = Object.fromEntries(['title','description'].map(key => [key, form.elements[key].value]));
  try { await api(path(selected()), json('PATCH', body)); await refreshEvent(); status('Series copy saved.'); } catch (error) { status(error.message); }
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
