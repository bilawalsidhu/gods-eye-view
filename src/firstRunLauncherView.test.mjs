// src/firstRunLauncherView.test.mjs — the welcome view renders the mission
// launcher initFirstRunExperience presents, and its buttons and checkbox call
// the launcher's controls.
import './testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import {
  FIRST_RUN_SESSION_KEY,
  FIRST_RUN_STORAGE_KEY,
  initFirstRunExperience,
} from './firstRunExperience.js';
import { useFirstRunStore } from './ui/stores/firstRun.js';
import WelcomeView from './ui/views/WelcomeView.vue';

function memoryStorage(key, { refuse = false } = {}) {
  const values = new Map();
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, next) => {
      if (refuse) throw new Error('blocked');
      values.set(name, next);
    },
    removeItem: (name) => {
      if (refuse) throw new Error('blocked');
      values.delete(name);
    },
    read: () => values.get(key) ?? null,
  };
}

/** The welcome view and an initialized launcher, revealed and painted. */
async function launch(t, { styleManager = {}, refuse = false } = {}) {
  document.body.replaceChildren();
  // Where focus was before the launcher opened.
  const opener = document.body.appendChild(document.createElement('button'));
  opener.focus();
  const frames = [];
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  const pinia = createPinia();
  const store = useFirstRunStore(pinia);
  const app = createApp(WelcomeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const storage = memoryStorage(FIRST_RUN_STORAGE_KEY, { refuse });
  const sessionStorageRef = memoryStorage(FIRST_RUN_SESSION_KEY);
  const launcher = initFirstRunExperience({
    styleManager,
    dataManager: { setEnabled: async () => true },
    documentRef: document,
    storage,
    sessionStorageRef,
    location: { search: '' },
    store,
  });
  t.after(() => {
    launcher?.destroy();
    app.unmount();
    globalThis.requestAnimationFrame = previousFrame;
  });
  await nextTick();
  const root = document.getElementById('first-run-launcher');
  // The list overflows its box until a test resizes it.
  const list = root.querySelector('.first-run-choices');
  const box = { scrollHeight: 400, clientHeight: 200 };
  Object.defineProperty(list, 'scrollHeight', { get: () => box.scrollHeight });
  Object.defineProperty(list, 'clientHeight', { get: () => box.clientHeight });
  for (const frame of frames.splice(0)) frame();
  await nextTick();
  return { launcher, root, list, box, opener, storage, sessionStorageRef };
}

test('the card is hidden until initialized, then revealed with its copy', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(WelcomeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const hidden = document.getElementById('first-run-launcher');
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.className, '');
  app.unmount();

  const { root, list } = await launch(t);
  assert.equal(root.hidden, false);
  assert.equal(root.classList.contains('visible'), true);
  assert.equal(root.hasAttribute('aria-hidden'), false);
  assert.equal(list.dataset.scrollable, 'true');
  assert.equal(
    root.querySelector('[data-first-run-status]').textContent,
    'Tip: the GEV MIC button in the dock lets you talk to the map.',
  );
  assert.equal(
    root.querySelector('[data-first-run-environmental-title]').textContent,
    'ENVIRONMENTAL',
  );
  assert.ok(
    document.activeElement === root.querySelector('[data-first-run-choice]'),
    'the first mission has focus',
  );
});

test('a busy mission marks the choices aria-disabled, never disabled', async (t) => {
  let finish;
  const { root } = await launch(t, {
    styleManager: {
      setContextMode: () => new Promise((resolve) => (finish = resolve)),
    },
  });
  const contacts = root.querySelector('[data-first-run-choice="contacts"]');
  contacts.focus();
  contacts.click();
  await nextTick();
  assert.equal(root.dataset.state, 'loading');
  assert.equal(root.getAttribute('aria-busy'), 'true');
  for (const button of root.querySelectorAll('[data-first-run-choice]')) {
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.disabled, false);
  }
  assert.ok(document.activeElement === contacts, 'focus stays on the choice');
  assert.equal(
    root.querySelector('[data-first-run-status]').textContent,
    'Starting live contacts…',
  );
  // A failed mission says so and stays on the card.
  finish({ ok: false });
  await new Promise((resolve) => setTimeout(resolve));
  await nextTick();
  assert.equal(root.dataset.state, 'ready');
  assert.equal(contacts.getAttribute('aria-disabled'), 'false');
  assert.match(
    root.querySelector('[data-first-run-status]').textContent,
    /^Could not open that mission/,
  );
});

test('a refused write takes the tick back and says why', async (t) => {
  const { root, storage } = await launch(t, { refuse: true });
  const box = root.querySelector('[data-first-run-suppress]');
  box.click();
  await nextTick();
  assert.equal(box.checked, false, 'the tick is taken back');
  assert.equal(storage.read(), null);
  assert.equal(
    root.querySelector('[data-first-run-status]').textContent,
    'This browser is blocking storage, so that could not be saved.',
  );
});

test('a saved tick stays ticked', async (t) => {
  const { root, storage } = await launch(t);
  const box = root.querySelector('[data-first-run-suppress]');
  box.click();
  await nextTick();
  assert.equal(box.checked, true);
  assert.equal(storage.read(), 'suppressed');
});

test('the DISMISS button closes the card the way ESC does', async (t) => {
  const { root, sessionStorageRef } = await launch(t);
  root.querySelector('[data-first-run-dismiss]').click();
  await nextTick();
  assert.equal(root.classList.contains('visible'), false);
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.notEqual(sessionStorageRef.read(), null, 'dismissed for the session');
  root.dispatchEvent(new Event('transitionend'));
  await nextTick();
  assert.equal(document.getElementById('first-run-launcher'), null);
});

test('the scroll fade clears when the tiles fit after a resize', async (t) => {
  const { list, box } = await launch(t);
  assert.equal(list.dataset.scrollable, 'true');
  box.scrollHeight = 200;
  window.dispatchEvent(new Event('resize'));
  await nextTick();
  assert.equal(list.dataset.scrollable, 'false');
});

test('ESC closes the card, returns focus, and removes it without a transition', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { root, opener, sessionStorageRef } = await launch(t);
  assert.ok(document.activeElement !== opener, 'the launcher took focus');
  document.activeElement.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await nextTick();
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.notEqual(sessionStorageRef.read(), null);
  assert.ok(document.activeElement === opener, 'focus returns where it was');
  // Reduced motion: no transitionend, so the bounded fallback removes it.
  t.mock.timers.tick(400);
  await nextTick();
  assert.equal(document.getElementById('first-run-launcher'), null);
});
