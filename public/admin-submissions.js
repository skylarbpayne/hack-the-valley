const tokenInput = document.getElementById('token');
const loadButton = document.getElementById('load');
const csvLink = document.getElementById('csv');
const statusEl = document.getElementById('status');
const submissionsEl = document.getElementById('submissions');
const cleanupForm = document.getElementById('cleanup-form');
const cleanupStatus = document.getElementById('cleanup-status');
const loadEventProjectsButton = document.getElementById('load-event-projects');
const eventProjectCleanupList = document.getElementById('event-project-cleanup-list');

tokenInput.value = localStorage.getItem('htvSubmissionAdminToken') || '';
const API_ORIGIN = 'https://hack-the-valley.pages.dev';

function apiUrl(path) {
  return window.location.hostname.endsWith('.pages.dev') ? path : `${API_ORIGIN}${path}`;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function token() {
  return tokenInput.value.trim();
}

function mediaUrl(key) {
  return apiUrl(`/api/media?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token())}`);
}

function cleanupEventSlug() {
  return cleanupForm.elements.event_slug.value.trim() || 'hack-the-valley-2026';
}

function fillCleanupProject(projectId, status = 'hidden', eventProjectSubmissionId = '', eventInstanceId = '') {
  cleanupForm.elements.project_id.value = projectId;
  cleanupForm.elements.status.value = status;
  cleanupForm.elements.event_instance_id.value = eventInstanceId || '';
  cleanupForm.dataset.eventProjectSubmissionId = eventProjectSubmissionId || '';
  cleanupStatus.textContent = `Ready to set ${projectId} to ${status}.`;
}

function renderEventProjects(projects = []) {
  if (!projects.length) {
    eventProjectCleanupList.innerHTML = '<div class="text-slate-500">No event-linked projects found.</div>';
    return;
  }
  eventProjectCleanupList.innerHTML = projects.map((project) => `
    <div class="rounded-xl border border-slate-700 bg-slate-950/50 p-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
      <div>
        <div class="font-bold text-white">${escapeHtml(project.title || project.project_id)}</div>
        <div class="font-mono text-xs text-slate-500">${escapeHtml(project.project_id)} · ${escapeHtml(project.status || 'submitted')} ${project.event_instance_id ? `· ${escapeHtml(project.event_instance_id)}` : ''} ${project.event_project_submission_id ? `· ${escapeHtml(project.event_project_submission_id)}` : ''}</div>
      </div>
      <div class="flex gap-2">
        <button type="button" data-cleanup-fill="${escapeHtml(project.project_id)}" data-cleanup-submission-id="${escapeHtml(project.event_project_submission_id || '')}" data-cleanup-instance-id="${escapeHtml(project.event_instance_id || '')}" data-cleanup-status="hidden" class="rounded-lg bg-amber-300 text-slate-950 px-3 py-2 font-bold">Hide</button>
        <button type="button" data-cleanup-fill="${escapeHtml(project.project_id)}" data-cleanup-submission-id="${escapeHtml(project.event_project_submission_id || '')}" data-cleanup-instance-id="${escapeHtml(project.event_instance_id || '')}" data-cleanup-status="submitted" class="rounded-lg border border-slate-600 px-3 py-2 font-bold text-slate-200">Restore</button>
      </div>
    </div>
  `).join('');
}

function renderUpload(upload) {
  const kind = String(upload.kind || '').toLowerCase();
  const filename = String(upload.filename || upload.key || 'uploaded file');
  const url = mediaUrl(upload.key);
  const safeFilename = escapeHtml(filename);
  const isImage = kind === 'image' || /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
  const isVideo = kind === 'video' || /\.(mp4|mov|m4v|webm|ogg)$/i.test(filename);
  const downloadLink = `
    <a class="inline-flex items-center gap-2 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-cyan-300 hover:text-cyan-200" target="_blank" rel="noopener" href="${url}">
      <span>${escapeHtml(kind || 'file')}</span>
      <span class="text-slate-500">Open/download ${safeFilename}</span>
    </a>
  `;

  if (isImage) {
    return `
      <figure class="rounded-xl bg-slate-950 border border-slate-700 overflow-hidden max-w-sm">
        <img class="w-full max-h-72 object-contain bg-black" src="${url}" alt="${safeFilename}" loading="lazy">
        <figcaption class="p-3 flex flex-col gap-2 text-sm">
          <span class="font-semibold text-slate-200">${safeFilename}</span>
          ${downloadLink}
        </figcaption>
      </figure>
    `;
  }

  if (isVideo) {
    return `
      <figure class="rounded-xl bg-slate-950 border border-slate-700 overflow-hidden max-w-xl">
        <video class="w-full max-h-80 bg-black" controls preload="metadata" src="${url}"></video>
        <figcaption class="p-3 flex flex-col gap-2 text-sm">
          <span class="font-semibold text-slate-200">${safeFilename}</span>
          ${downloadLink}
        </figcaption>
      </figure>
    `;
  }

  return downloadLink;
}

function render(submissions) {
  if (!submissions.length) {
    submissionsEl.innerHTML = '<div class="rounded-2xl bg-slate-900 border border-slate-800 p-6 text-slate-400">No submissions yet.</div>';
    return;
  }

  submissionsEl.innerHTML = submissions.map((submission) => {
    const payload = submission.payload || {};
    const uploads = submission.uploads || [];
    const uploadHtml = uploads.length
      ? uploads.map(renderUpload).join('')
      : '<span class="text-slate-500">No uploaded files</span>';

    const links = [
      ['Repo', payload.repoLink],
      ['Demo', payload.demoLink],
      ['Media fallback', payload.mediaLink],
    ].filter(([, href]) => href).map(([label, href]) => `<a class="text-cyan-300 hover:text-cyan-200" target="_blank" rel="noopener" href="${escapeHtml(href)}">${label}</a>`).join(' · ');

    const trackText = submission.track || (submission.tracks || []).join(' | ') || 'No track selected';

    return `
      <article class="rounded-2xl bg-slate-900 border border-slate-800 p-6">
        <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <div class="text-sm text-slate-500">${escapeHtml(submission.createdAt)} · ${escapeHtml(submission.id)}</div>
            <h2 class="text-2xl font-black mt-1">${escapeHtml(submission.projectTitle)}</h2>
            <p class="text-slate-300 mt-1"><strong>${escapeHtml(submission.teamName)}</strong> · ${escapeHtml(trackText)} · ${escapeHtml(submission.contactEmail)}</p>
          </div>
          <span class="self-start rounded-full bg-cyan-950 text-cyan-200 border border-cyan-800 px-3 py-1 text-sm font-bold">${escapeHtml(submission.status)}</span>
        </div>
        <p class="text-slate-300 mt-4 whitespace-pre-wrap">${escapeHtml(payload.description)}</p>
        <dl class="grid md:grid-cols-2 gap-4 mt-4 text-sm">
          <div><dt class="text-slate-500 font-bold uppercase tracking-wide">Members</dt><dd class="text-slate-300 whitespace-pre-wrap">${escapeHtml(payload.members)}</dd></div>
          <div><dt class="text-slate-500 font-bold uppercase tracking-wide">Judge notes</dt><dd class="text-slate-300 whitespace-pre-wrap">${escapeHtml(payload.notes || '')}</dd></div>
        </dl>
        <div class="mt-4 text-sm">${links || '<span class="text-slate-500">No links provided</span>'}</div>
        <div class="mt-4 grid md:grid-cols-2 xl:grid-cols-3 gap-4">${uploadHtml}</div>
      </article>
    `;
  }).join('');
}

async function load() {
  if (!token()) {
    statusEl.textContent = 'Paste the admin token first.';
    return;
  }
  localStorage.setItem('htvSubmissionAdminToken', token());
  loadButton.disabled = true;
  loadButton.textContent = 'Loading...';
  statusEl.textContent = '';
  try {
    const response = await fetch(apiUrl('/api/submissions'), { headers: { 'x-admin-token': token() } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    render(data.submissions || []);
    csvLink.href = apiUrl(`/api/submissions?format=csv&token=${encodeURIComponent(token())}`);
    csvLink.classList.remove('hidden');
    statusEl.textContent = `${data.submissions.length} submission(s) loaded.`;
  } catch (error) {
    statusEl.textContent = error.message;
    submissionsEl.innerHTML = '';
  } finally {
    loadButton.disabled = false;
    loadButton.textContent = 'Load submissions';
  }
}

loadButton.addEventListener('click', load);

loadEventProjectsButton.addEventListener('click', async () => {
  if (!token()) {
    cleanupStatus.textContent = 'Paste the admin token first.';
    return;
  }
  cleanupStatus.textContent = 'Loading event-linked projects…';
  try {
    const eventSlug = cleanupEventSlug();
    const response = await fetch(apiUrl(`/api/events/${encodeURIComponent(eventSlug)}/projects`), {
      headers: { 'x-admin-token': token() },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderEventProjects(data.projects || []);
    cleanupStatus.textContent = `${data.count || 0} event-linked project(s) loaded.`;
  } catch (error) {
    cleanupStatus.textContent = error.message;
  }
});

eventProjectCleanupList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-cleanup-fill]');
  if (!button) return;
  fillCleanupProject(
    button.dataset.cleanupFill,
    button.dataset.cleanupStatus || 'hidden',
    button.dataset.cleanupSubmissionId || '',
    button.dataset.cleanupInstanceId || ''
  );
});

cleanupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!token()) {
    cleanupStatus.textContent = 'Paste the admin token first.';
    return;
  }
  const form = event.currentTarget;
  const eventSlug = cleanupEventSlug();
  const projectId = form.elements.project_id.value.trim();
  const status = form.elements.status.value.trim();
  const eventInstanceId = form.elements.event_instance_id.value.trim();
  const eventProjectSubmissionId = form.dataset.eventProjectSubmissionId || '';
  if (!eventSlug || !projectId) {
    cleanupStatus.textContent = 'Event and project ID are required.';
    return;
  }
  cleanupStatus.textContent = `Updating ${projectId}…`;
  try {
    const response = await fetch(apiUrl(`/api/events/${encodeURIComponent(eventSlug)}/projects/${encodeURIComponent(projectId)}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-admin-token': token() },
      body: JSON.stringify({
        status,
        ...(eventInstanceId ? { event_instance_id: eventInstanceId } : {}),
        ...(eventProjectSubmissionId ? { event_project_submission_id: eventProjectSubmissionId } : {})
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    cleanupStatus.textContent = `${projectId} is now ${data.project?.status || status}. No records were deleted.`;
  } catch (error) {
    cleanupStatus.textContent = error.message;
  }
});
