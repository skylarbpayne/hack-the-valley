function setStatus(form, message, tone = 'neutral') {
  const status = form.querySelector('[data-subscribe-status]');
  if (!status) return;
  status.textContent = message;
  status.classList.remove('text-slate-400', 'text-green-300', 'text-red-300');
  status.classList.add(tone === 'success' ? 'text-green-300' : tone === 'error' ? 'text-red-300' : 'text-slate-400');
}

function completedControls(form) {
  return form.querySelectorAll('input:not([type="hidden"]):not([name="website"]), textarea, button');
}

function lockCompletedForm(form, submit, message) {
  form.reset();
  form.dataset.subscribeComplete = 'true';
  for (const control of completedControls(form)) {
    control.disabled = true;
    control.setAttribute('aria-disabled', 'true');
    control.classList.add('opacity-60', 'cursor-not-allowed');
  }
  if (submit) {
    submit.textContent = "You're on the list";
  }
  setStatus(form, message, 'success');
}

async function subscribe(form) {
  if (form.dataset.subscribeComplete === 'true') return;

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
    lockCompletedForm(form, submit, body.message || 'You are on the Hack the Valley updates list.');
  } catch (error) {
    setStatus(form, `${error.message || 'Signup failed.'} If this keeps happening, email contact@hackthevalley.org.`, 'error');
  } finally {
    if (submit && form.dataset.subscribeComplete !== 'true') {
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
