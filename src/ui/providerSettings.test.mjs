// src/ui/providerSettings.test.mjs — Provider Settings (the dev-only key
// setup) renders what src/keySetup.js presents, and its controls reach the
// owner, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { initKeySetup } from '../keySetup.js';
import { CLOUD_VOICE_AUTH_STORAGE_KEY } from '../voice/cloudVoiceAuth.js';
import { useProviderSettingsStore } from './stores/providerSettings.js';
import ProviderSettingsView from './views/ProviderSettingsView.vue';

const STATUS = Object.freeze({
  total: 3,
  setCount: 1,
  store: 'dotenv',
  keys: [
    {
      id: 'google-maps',
      title: 'Google Maps',
      tier: 'metered',
      set: false,
      managed: null,
      clientExposed: true,
      getUrl: 'https://example.test/google',
      unlocks: 'Photorealistic 3D tiles',
      envVars: ['GOOGLE_MAPS_API_KEY'],
    },
    {
      id: 'openai',
      title: 'OpenAI',
      tier: 'paid',
      set: true,
      managed: 'file',
      getUrl: 'https://example.test/openai',
      unlocks: 'Cloud voice',
      envVars: ['OPENAI_API_KEY'],
    },
    {
      id: 'firms',
      title: 'NASA FIRMS',
      tier: 'free',
      set: true,
      managed: 'external',
      getUrl: 'https://example.test/firms',
      unlocks: 'Fire detections',
      envVars: ['FIRMS_MAP_KEY'],
    },
  ],
});

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function fixture(t, { status = STATUS, respond = null } = {}) {
  document.body.replaceChildren();
  delete document.documentElement.dataset.uiTheme;
  const toolbar = document.body.appendChild(document.createElement('div'));
  toolbar.id = 'top-center-actions';
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(
    defineComponent(() => () => h(ProviderSettingsView)),
  ).use(pinia);
  app.mount(host);
  const store = useProviderSettingsStore(pinia);
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url === '/api/setup/status') {
      if (!status) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => status };
    }
    return respond(url, init);
  };
  const controller = new AbortController();
  const setup = await initKeySetup({
    documentRef: document,
    fetchImpl,
    signal: controller.signal,
    store,
  });
  await nextTick();
  t.after(() => {
    controller.abort();
    app.unmount();
  });
  const $ = (selector) => document.querySelector(selector);
  const text = (selector) => $(selector)?.textContent.trim();
  return { $, text, store, setup, requests, toolbar };
}

test('an unavailable setup endpoint removes the chip and the dialog', async (t) => {
  const { $ } = await fixture(t, { status: null });
  assert.equal($('#key-setup-chip'), null);
  assert.equal($('#key-setup'), null);
  assert.ok($('#corner-actions'));
});

test('the chip counts what is missing and the rows render from the status', async (t) => {
  const { $, text } = await fixture(t);
  const chip = $('#key-setup-chip');
  assert.equal(chip.hidden, false);
  assert.equal(
    text('[data-key-setup-chip-label]'),
    'POWER UP · 2 KEYS WAITING',
  );
  assert.equal(chip.title, 'Project keys: POWER UP · 2 KEYS WAITING');
  assert.equal(chip.getAttribute('aria-label'), chip.title);
  assert.equal($('#key-setup').dataset.ready, 'true');
  assert.equal($('#key-setup').hidden, true);

  const google = $('[data-key-id="google-maps"]');
  assert.equal(google.dataset.set, 'false');
  assert.equal(google.hasAttribute('data-managed'), false);
  assert.equal(google.querySelector('strong').textContent, 'Google Maps');
  assert.equal(google.querySelector('.key-setup-tier').textContent, '🔴');
  assert.equal(
    google.querySelector('.key-setup-tier').title,
    'Metered — a billing-enabled account',
  );
  assert.equal(
    google.querySelector('.key-setup-exposed').textContent,
    'browser-side',
  );
  assert.equal(google.querySelector('.key-setup-get').textContent, 'GET KEY ↗');
  assert.equal(
    google.querySelector('.key-setup-get').getAttribute('rel'),
    'noopener noreferrer',
  );
  const field = google.querySelector(
    'input[data-env-var="GOOGLE_MAPS_API_KEY"]',
  );
  assert.equal(field.type, 'password');
  assert.equal(field.placeholder, 'paste GOOGLE_MAPS_API_KEY');
  assert.equal(google.querySelector('.key-setup-remove'), null);
  assert.equal(google.querySelector('.key-setup-cloud-auth'), null);

  const openai = $('[data-key-id="openai"]');
  assert.equal(openai.dataset.managed, 'file');
  assert.equal(openai.querySelector('.key-setup-get').textContent, 'MANAGE ↗');
  assert.equal(
    openai.querySelector('input').placeholder,
    'OPENAI_API_KEY saved — paste to replace',
  );
  const remove = openai.querySelector('.key-setup-remove');
  assert.equal(remove.textContent, 'REMOVE');
  assert.equal(remove.title, "Remove OpenAI from this app's saved keys");
  assert.equal(remove.dataset.keySetupRemove, '["OPENAI_API_KEY"]');
  assert.equal(
    text('[data-key-id="openai"] .key-setup-cloud-auth-state'),
    'VOICE AUTH · API KEY',
  );

  const firms = $('[data-key-id="firms"]');
  assert.equal(
    firms.querySelector('.key-setup-external').textContent,
    'configured externally',
  );
  assert.equal(firms.querySelector('.key-setup-fields'), null);
});

test('the chip opens the dialog onto its first field; closing fades it and restores the status line', async (t) => {
  const { $, text } = await fixture(t);
  const chip = $('#key-setup-chip');
  chip.focus();
  chip.click();
  await nextTick();
  const dialog = $('#key-setup');
  assert.equal(dialog.hidden, false);
  assert.equal(dialog.classList.contains('visible'), false);
  await frame();
  await wait();
  assert.equal(dialog.classList.contains('visible'), true);
  assert.equal(document.activeElement?.dataset.envVar, 'GOOGLE_MAPS_API_KEY');

  $('[data-key-setup-apply]').click();
  await nextTick();
  assert.equal(
    text('[data-key-setup-status]'),
    'Paste at least one key first.',
  );

  $('[data-key-setup-close]').click();
  await nextTick();
  assert.equal(dialog.classList.contains('visible'), false);
  assert.equal(dialog.hidden, false);
  assert.equal(
    text('[data-key-setup-status]'),
    'The Google Maps key buys the photorealistic planet — everything else stacks on top.',
  );
  dialog.dispatchEvent(new Event('transitionend', { bubbles: true }));
  await nextTick();
  assert.equal(dialog.hidden, true);
  assert.equal(document.activeElement === chip, true);
});

test('saving posts the pasted keys, clears the fields and shows the result', async (t) => {
  let finish;
  const { $, text, requests } = await fixture(t, {
    respond: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const field = $('input[data-env-var="GOOGLE_MAPS_API_KEY"]');
  field.value = '  AIza-test  ';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  const apply = $('[data-key-setup-apply]');
  assert.equal(apply.hasAttribute('aria-disabled'), false);
  apply.click();
  await nextTick();
  assert.equal(apply.getAttribute('aria-disabled'), 'true');
  assert.equal(text('[data-key-setup-status]'), 'Saving…');
  assert.deepEqual(requests.at(-1), {
    url: '/api/setup/keys',
    body: { GOOGLE_MAPS_API_KEY: 'AIza-test' },
  });
  finish({
    ok: true,
    json: async () => ({
      ok: true,
      saved: ['GOOGLE_MAPS_API_KEY'],
      status: {
        ...STATUS,
        setCount: 3,
        keys: STATUS.keys.map((key) => ({ ...key, set: true })),
      },
    }),
  });
  await wait();
  await nextTick();
  assert.equal(apply.getAttribute('aria-disabled'), 'false');
  assert.equal(
    text('[data-key-setup-status]'),
    'Saved to your local .env. Restarting — this page reloads itself.',
  );
  assert.equal($('input[data-env-var="GOOGLE_MAPS_API_KEY"]').value, '');
  assert.equal(
    $('input[data-env-var="GOOGLE_MAPS_API_KEY"]').placeholder,
    'GOOGLE_MAPS_API_KEY saved — paste to replace',
  );
  // Fully powered retires the chip.
  assert.equal($('#key-setup-chip').hidden, true);
});

test('removing a saved key asks first and posts nulls', async (t) => {
  const { $, requests } = await fixture(t, {
    respond: async () => ({
      ok: true,
      json: async () => ({ ok: true, saved: [], status: STATUS }),
    }),
  });
  const original = globalThis.confirm;
  const asked = [];
  let answer = false;
  globalThis.confirm = (message) => {
    asked.push(message);
    return answer;
  };
  t.after(() => {
    globalThis.confirm = original;
  });
  $('.key-setup-remove').click();
  assert.deepEqual(asked, ['Remove this key from your saved configuration?']);
  assert.equal(requests.length, 1);
  answer = true;
  $('.key-setup-remove').click();
  await wait();
  assert.deepEqual(requests.at(-1), {
    url: '/api/setup/keys',
    body: { OPENAI_API_KEY: null },
  });
});

test('the cloud voice toggle switches back to the API key and says so', async (t) => {
  localStorage.setItem(CLOUD_VOICE_AUTH_STORAGE_KEY, 'oauth');
  t.after(() => localStorage.removeItem(CLOUD_VOICE_AUTH_STORAGE_KEY));
  const { $, text } = await fixture(t);
  const toggle = $('[data-cloud-voice-auth-toggle]');
  assert.equal(
    text('.key-setup-cloud-auth-state'),
    'VOICE AUTH · CHATGPT OAUTH',
  );
  assert.equal(toggle.textContent, 'USE API KEY');
  toggle.click();
  await nextTick();
  assert.equal(localStorage.getItem(CLOUD_VOICE_AUTH_STORAGE_KEY), 'api-key');
  assert.equal(text('.key-setup-cloud-auth-state'), 'VOICE AUTH · API KEY');
  assert.equal(toggle.textContent, 'USE CHATGPT OAUTH');
  assert.equal(toggle.getAttribute('aria-disabled'), 'false');
  assert.equal(
    text('[data-key-setup-status]'),
    'Cloud voice will use OPENAI_API_KEY on the next session.',
  );
});

test('while the OAuth check runs, the toggle is busy and repeat presses are ignored', async (t) => {
  let finish;
  const calls = [];
  const { $, text } = await fixture(t, {
    respond: (url) => {
      calls.push(url);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const toggle = $('[data-cloud-voice-auth-toggle]');
  toggle.click();
  await nextTick();
  assert.equal(toggle.getAttribute('aria-disabled'), 'true');
  assert.equal(
    text('[data-key-setup-status]'),
    'Checking local ChatGPT OAuth sign-in…',
  );
  toggle.click();
  assert.deepEqual(calls, ['/api/realtime/oauth-status']);
  finish({ ok: true, json: async () => ({ available: true }) });
  await wait();
  await nextTick();
  assert.equal(toggle.getAttribute('aria-disabled'), 'false');
  assert.equal(
    text('.key-setup-cloud-auth-state'),
    'VOICE AUTH · CHATGPT OAUTH',
  );
  localStorage.removeItem(CLOUD_VOICE_AUTH_STORAGE_KEY);
});

test('Cyber moves the chip into the top toolbar and other themes return it to the corner', async (t) => {
  const { $, toolbar } = await fixture(t);
  const corner = $('#corner-actions');
  assert.equal(corner.firstElementChild?.id, 'key-setup-chip');
  document.documentElement.dataset.uiTheme = 'cyber';
  await wait();
  await nextTick();
  assert.equal(toolbar.lastElementChild?.id, 'key-setup-chip');
  assert.equal(corner.querySelector('#key-setup-chip'), null);
  document.documentElement.dataset.uiTheme = 'tactical';
  await wait();
  await nextTick();
  assert.equal(corner.firstElementChild?.id, 'key-setup-chip');
  assert.equal(toolbar.querySelector('#key-setup-chip'), null);
  delete document.documentElement.dataset.uiTheme;
});

test('a field focused while a save completes does not keep the saved key', async (t) => {
  let finish;
  const { $ } = await fixture(t, {
    respond: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const field = $('input[data-env-var="GOOGLE_MAPS_API_KEY"]');
  field.value = 'AIza-test';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  $('[data-key-setup-apply]').click();
  await nextTick();
  field.focus();
  finish({
    ok: true,
    json: async () => ({ ok: true, saved: [], status: STATUS }),
  });
  await wait();
  await nextTick();
  const fresh = $('input[data-env-var="GOOGLE_MAPS_API_KEY"]');
  assert.equal(fresh.value, '');
  assert.equal(fresh.isConnected, true);
});

test('a repeated status message is written again for the live region', async (t) => {
  const { $ } = await fixture(t);
  const line = $('[data-key-setup-status]');
  const writes = [];
  const observer = new MutationObserver((records) =>
    writes.push(records.length),
  );
  observer.observe(line, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  t.after(() => observer.disconnect());
  $('[data-key-setup-apply]').click();
  await nextTick();
  await wait();
  const first = writes.length;
  assert.ok(first > 0);
  $('[data-key-setup-apply]').click();
  await nextTick();
  await wait();
  assert.ok(writes.length > first);
  assert.equal(line.textContent, 'Paste at least one key first.');
});

test('the chip does nothing until the setup endpoint has answered', async (t) => {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(ProviderSettingsView).use(pinia);
  app.mount(host);
  const store = useProviderSettingsStore(pinia);
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    app.unmount();
  });
  void initKeySetup({
    documentRef: document,
    fetchImpl: () => new Promise(() => {}),
    signal: controller.signal,
    store,
  });
  await nextTick();
  store.controls.open();
  await nextTick();
  assert.equal(document.getElementById('key-setup').hidden, true);
});
