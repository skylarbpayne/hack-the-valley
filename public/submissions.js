const form = document.getElementById('submission-form');
const statusBox = document.getElementById('status');
const submitButton = document.getElementById('submit-button');
const uploadList = document.getElementById('upload-list');

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function value(id) {
  return document.getElementById(id).value.trim();
}

function showStatus(type, message) {
  statusBox.className = `mb-6 rounded-xl border p-4 ${type === 'error' ? 'bg-red-950/60 border-red-700 text-red-100' : 'bg-green-950/60 border-green-700 text-green-100'}`;
  statusBox.innerHTML = message;
  statusBox.classList.remove('hidden');
  statusBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function uploadRow(file, kind) {
  const row = document.createElement('div');
  row.className = 'rounded-xl bg-bc-dark border border-slate-700 p-4';
  row.innerHTML = `
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="font-bold text-slate-100">${escapeHtml(file.name)}</div>
        <div class="text-sm text-slate-400">${kind} • ${formatBytes(file.size)}</div>
      </div>
      <div class="text-sm font-semibold text-bc-cyan" data-state>Queued</div>
    </div>
    <div class="mt-3 h-2 bg-slate-800 rounded-full overflow-hidden"><div class="h-full bg-bc-cyan w-0" data-bar></div></div>
  `;
  uploadList.appendChild(row);
  return row;
}

function setProgress(row, percent, state) {
  row.querySelector('[data-bar]').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  row.querySelector('[data-state]').textContent = state;
}

function formatBytes(bytes) {
  if (!bytes) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function uploadFile(file, kind) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${file.name} is over 100MB. Paste a YouTube/Loom/Drive link instead.`);
  }

  const row = uploadRow(file, kind);
  const params = new URLSearchParams({
    filename: file.name,
    kind,
    teamName: value('teamName') || 'submission',
    projectTitle: value('projectTitle') || '',
  });

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?${params.toString()}`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) setProgress(row, (event.loaded / event.total) * 100, 'Uploading');
    });
    xhr.addEventListener('load', () => {
      let response;
      try { response = JSON.parse(xhr.responseText); } catch { response = {}; }
      if (xhr.status >= 200 && xhr.status < 300 && response.upload) {
        setProgress(row, 100, 'Uploaded');
        resolve(response.upload);
      } else {
        setProgress(row, 100, 'Failed');
        reject(new Error(response.error || (response.errors || []).join(' ') || `Upload failed with HTTP ${xhr.status}`));
      }
    });
    xhr.addEventListener('error', () => {
      setProgress(row, 100, 'Failed');
      reject(new Error(`Upload failed for ${file.name}. Try the media-link fallback.`));
    });
    setProgress(row, 1, 'Uploading');
    xhr.send(file);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  statusBox.classList.add('hidden');
  uploadList.innerHTML = '';
  submitButton.disabled = true;
  submitButton.textContent = 'Uploading...';

  try {
    const uploads = [];
    const video = document.getElementById('videoFile').files[0];
    const images = [...document.getElementById('imageFiles').files];

    if (video) uploads.push(await uploadFile(video, 'video'));
    for (const image of images) uploads.push(await uploadFile(image, 'image'));

    submitButton.textContent = 'Saving submission...';
    const payload = {
      teamName: value('teamName'),
      projectTitle: value('projectTitle'),
      contactEmail: value('contactEmail'),
      track: value('track'),
      members: value('members'),
      description: value('description'),
      repoLink: value('repoLink'),
      demoLink: value('demoLink'),
      mediaLink: value('mediaLink'),
      notes: value('notes'),
      website: value('website'),
      uploads,
    };

    const response = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.errors?.join(' ') || result.error || 'Submission failed.');
    }

    showStatus('success', `<strong>Submitted.</strong> Confirmation ID: <code class="font-mono bg-black/30 px-2 py-1 rounded">${escapeHtml(result.id)}</code><br>Save that ID. You are good.`);
    form.reset();
    uploadList.innerHTML = '';
  } catch (error) {
    showStatus('error', `<strong>Submission not saved.</strong> ${escapeHtml(error.message)}<br><span class="text-sm text-red-200">If this is a video-size issue, paste a YouTube/Loom/Drive link and submit without uploading the huge file.</span>`);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Submit project';
  }
});
