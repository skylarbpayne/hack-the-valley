const tokenInput = document.getElementById('token');
const loadButton = document.getElementById('load');
const csvLink = document.getElementById('csv');
const statusEl = document.getElementById('status');
const submissionsEl = document.getElementById('submissions');

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
