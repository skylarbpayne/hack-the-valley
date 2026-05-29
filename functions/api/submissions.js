const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const TRACKS = new Set(['ai', 'fintech', 'health', 'social-good', 'open']);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function text(value) {
  return String(value || '').trim();
}

function hasUsableFile(file) {
  return file && typeof file === 'object' && 'size' in file && file.size > 0 && file.name;
}

function safeFilename(name) {
  return String(name || 'upload')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'upload';
}

function submissionId() {
  const stamp = Date.now().toString(36);
  const random = crypto.randomUUID().split('-')[0];
  return `htv_${stamp}_${random}`;
}

function validateRequired(data) {
  const missing = [];
  if (!data.teamName) missing.push('team name');
  if (!data.contactName) missing.push('contact name');
  if (!data.contactEmail) missing.push('contact email');
  if (!data.projectTitle) missing.push('project title');
  if (!data.track) missing.push('track');
  if (!data.description) missing.push('description');
  if (missing.length) return `Missing required ${missing.join(', ')}`;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contactEmail)) {
    return 'Invalid contact email';
  }
  if (!TRACKS.has(data.track)) {
    return 'Invalid track';
  }
  if (data.description.length < 20) {
    return 'Description must be at least 20 characters';
  }
  return null;
}

function validateFiles({ images, video }) {
  if (images.length > MAX_IMAGES) return `Upload no more than ${MAX_IMAGES} images`;
  for (const image of images) {
    if (!image.type?.startsWith('image/')) return `${image.name} must be an image file`;
    if (image.size > MAX_IMAGE_BYTES) return `${image.name} is larger than 15 MB`;
  }
  if (video) {
    if (!video.type?.startsWith('video/')) return `${video.name} must be a video file`;
    if (video.size > MAX_VIDEO_BYTES) return `${video.name} is larger than 500 MB`;
  }
  return null;
}

async function uploadFile(bucket, id, kind, file) {
  const key = `${id}/${kind}/${crypto.randomUUID()}-${safeFilename(file.name)}`;
  await bucket.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type || 'application/octet-stream',
      contentDisposition: `inline; filename="${safeFilename(file.name)}"`
    },
    customMetadata: {
      originalName: file.name,
      kind
    }
  });
  return {
    kind,
    key,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size
  };
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env?.SUBMISSIONS_BUCKET || !env?.SUBMISSIONS_DB) {
      return json({ success: false, error: 'Submission storage is not configured' }, 500);
    }

    if (env.SUBMISSIONS_DEADLINE_ISO) {
      const deadline = new Date(env.SUBMISSIONS_DEADLINE_ISO);
      if (!Number.isNaN(deadline.valueOf()) && new Date() > deadline) {
        return json({ success: false, error: 'Submissions are closed' }, 403);
      }
    }

    const form = await request.formData();
    const data = {
      teamName: text(form.get('teamName')),
      contactName: text(form.get('contactName')),
      contactEmail: text(form.get('contactEmail')).toLowerCase(),
      members: text(form.get('members')),
      projectTitle: text(form.get('projectTitle')),
      track: text(form.get('track')),
      description: text(form.get('description')),
      demoUrl: text(form.get('demoUrl')),
      repoUrl: text(form.get('repoUrl')),
      slidesUrl: text(form.get('slidesUrl'))
    };

    const dataError = validateRequired(data);
    if (dataError) return json({ success: false, error: dataError }, 400);

    const images = form.getAll('images').filter(hasUsableFile);
    const video = hasUsableFile(form.get('video')) ? form.get('video') : null;
    const fileError = validateFiles({ images, video });
    if (fileError) return json({ success: false, error: fileError }, 400);

    const id = submissionId();
    const submittedAt = new Date().toISOString();
    const media = [];

    for (const image of images) {
      media.push(await uploadFile(env.SUBMISSIONS_BUCKET, id, 'image', image));
    }
    if (video) {
      media.push(await uploadFile(env.SUBMISSIONS_BUCKET, id, 'video', video));
    }

    await env.SUBMISSIONS_DB.prepare(`
      INSERT INTO submissions (
        id, submitted_at, team_name, contact_name, contact_email, project_title,
        track, description, demo_url, repo_url, slides_url, members, media_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      submittedAt,
      data.teamName,
      data.contactName,
      data.contactEmail,
      data.projectTitle,
      data.track,
      data.description,
      data.demoUrl,
      data.repoUrl,
      data.slidesUrl,
      data.members,
      JSON.stringify(media),
      'submitted'
    ).run();

    return json({
      success: true,
      submissionId: id,
      message: 'Project submitted. Save this confirmation ID.'
    });
  } catch (error) {
    console.error('Submission error:', error);
    return json({ success: false, error: 'Internal submission error' }, 500);
  }
}
