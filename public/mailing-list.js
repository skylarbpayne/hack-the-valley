function setStatus(form, message, tone = 'neutral') {
  const status = form.querySelector('[data-subscribe-status]');
  if (!status) return;
  status.textContent = message;
  status.classList.remove('text-slate-400', 'text-green-300', 'text-red-300');
  status.classList.add(tone === 'success' ? 'text-green-300' : tone === 'error' ? 'text-red-300' : 'text-slate-400');
}

async function subscribe(form) {
  const submit = form.querySelector('[type="submit"]');
  const originalText = submit?.textContent;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Joining…';
  }
  setStatus(form, 'Adding you to the updates list…');

  try {
    const response = await fetch(form.action || '/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      throw new Error(body.error || 'Signup failed.');
    }
    form.reset();
    setStatus(form, body.message || 'You are on the Hack the Valley updates list.', 'success');
  } catch (error) {
    setStatus(form, `${error.message || 'Signup failed.'} If this keeps happening, email contact@hackthevalley.org.`, 'error');
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = originalText || 'Join the list';
    }
  }
}

for (const form of document.querySelectorAll('[data-subscribe-form]')) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    subscribe(form);
  });
}
