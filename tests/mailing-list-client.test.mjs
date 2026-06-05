import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function makeClassList(initial = []) {
  const classes = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toString: () => [...classes].join(' '),
  };
}

function makeControl({ name, type = 'text', value = '', textContent = '' }) {
  return {
    name,
    type,
    value,
    textContent,
    disabled: false,
    classList: makeClassList(),
    attributes: {},
    setAttribute(key, val) {
      this.attributes[key] = String(val);
    },
    getAttribute(key) {
      return this.attributes[key];
    },
  };
}

function makeSubscribeForm() {
  const status = {
    textContent: '',
    classList: makeClassList(['text-slate-400']),
  };
  const controls = {
    website: makeControl({ name: 'website', value: '' }),
    source: makeControl({ name: 'source', type: 'hidden', value: 'homepage' }),
    email: makeControl({ name: 'email', type: 'email', value: 'student@example.com' }),
    name: makeControl({ name: 'name', value: 'Student One' }),
    interest: makeControl({ name: 'interest', value: 'mentor nights' }),
    submit: makeControl({ name: '', type: 'submit', textContent: 'Join the list' }),
  };
  const form = {
    action: '/api/subscribe',
    dataset: {},
    listeners: {},
    controls,
    reset() {
      controls.website.value = '';
      controls.email.value = '';
      controls.name.value = '';
      controls.interest.value = '';
    },
    querySelector(selector) {
      if (selector === '[type="submit"]') return controls.submit;
      if (selector === '[data-subscribe-status]') return status;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'input:not([type="hidden"]):not([name="website"]), textarea, button') {
        return [controls.email, controls.name, controls.interest, controls.submit];
      }
      return [];
    },
    addEventListener(eventName, listener) {
      this.listeners[eventName] = listener;
    },
  };
  return { form, status, controls };
}

async function flushAsyncSubmit() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function loadMailingListScript(form, fetchImpl) {
  const source = readFileSync(new URL('../public/mailing-list.js', import.meta.url), 'utf8');
  const context = {
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '[data-subscribe-form]');
        return [form];
      },
    },
    FormData: class FakeFormData {
      constructor(currentForm) {
        this.currentForm = currentForm;
      }
      entries() {
        return Object.values(this.currentForm.controls)
          .filter((control) => control.name)
          .map((control) => [control.name, control.value]);
      }
    },
    fetch: fetchImpl,
  };
  vm.runInNewContext(source, context, { filename: 'mailing-list.js' });
}

test('successful mailing-list signup clears and locks the form against accidental resubmission', async () => {
  const { form, status, controls } = makeSubscribeForm();
  const requests = [];
  loadMailingListScript(form, async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async json() {
        return { ok: true, message: 'You are on the Hack the Valley updates list.' };
      },
    };
  });

  let prevented = false;
  form.listeners.submit({ preventDefault: () => { prevented = true; } });
  await flushAsyncSubmit();

  assert.equal(prevented, true);
  assert.equal(requests.length, 1);
  assert.equal(controls.email.value, '');
  assert.equal(controls.name.value, '');
  assert.equal(controls.interest.value, '');
  assert.equal(form.dataset.subscribeComplete, 'true');
  assert.equal(controls.email.disabled, true);
  assert.equal(controls.name.disabled, true);
  assert.equal(controls.interest.disabled, true);
  assert.equal(controls.submit.disabled, true);
  assert.equal(controls.submit.textContent, "You're on the list");
  assert.equal(controls.email.getAttribute('aria-disabled'), 'true');
  assert.match(status.textContent, /updates list/);
  assert.equal(status.classList.contains('text-green-300'), true);

  form.listeners.submit({ preventDefault: () => {} });
  await flushAsyncSubmit();

  assert.equal(requests.length, 1, 'completed form should not submit again');
});
