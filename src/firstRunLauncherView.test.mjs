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
import { useStoriesStore } from './ui/stores/stories.js';
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
async function launch(
  t,
  {
    styleManager = {},
    dataManager = { setEnabled: async () => true },
    refuse = false,
  } = {},
) {
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
    dataManager,
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
  return {
    launcher,
    pinia,
    root,
    list,
    box,
    opener,
    storage,
    sessionStorageRef,
    frames,
  };
}

async function move(root, frames, selector = '[data-first-run-next]') {
  root.querySelector(selector).click();
  await settle(frames);
}

async function settle(frames) {
  for (let i = 0; i < 4; i++) {
    await nextTick();
    for (const frame of frames.splice(0)) frame();
    await new Promise((resolve) => setTimeout(resolve));
  }
  await nextTick();
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

  const { root, list, frames } = await launch(t);
  assert.equal(root.hidden, false);
  assert.equal(root.classList.contains('visible'), true);
  assert.equal(root.hasAttribute('aria-hidden'), false);
  assert.equal(list.dataset.scrollable, 'true');
  assert.equal(root.querySelector('[data-first-run-status]').textContent, '');
  assert.equal(root.querySelector('[data-first-run-choice]'), null);
  assert.ok(
    document.activeElement === root.querySelector('[data-first-run-primary]'),
  );
  await move(root, frames);
  assert.deepEqual(
    [...root.querySelectorAll('[data-first-run-start]')].map(
      (node) => node.dataset.firstRunStart,
    ),
    ['space-missions', 'environmental', 'explore'],
  );
  const environmental = root.querySelector(
    '[data-first-run-start="environmental"]',
  );
  assert.equal(
    environmental.querySelector('strong').textContent,
    'ENVIRONMENTAL',
  );
  assert.match(
    environmental.querySelector('small').textContent,
    /earthquakes.*fires/i,
  );
  assert.equal(
    root
      .querySelector('[data-first-run-start="explore"]')
      .getAttribute('aria-pressed'),
    'true',
  );
  assert.ok(
    document.activeElement === root.querySelector('[data-first-run-primary]'),
  );
});

test('a quick second click on NEXT moves on, and never launches', async (t) => {
  let calls = 0;
  const { root, frames } = await launch(t, {
    dataManager: {
      setEnabled: async () => {
        calls++;
        return true;
      },
    },
  });
  const primary = root.querySelector('[data-first-run-primary]');
  const press = (detail) => {
    primary.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    primary.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  };
  press(1);
  await settle(frames);
  assert.ok(root.querySelector('[data-first-run-start]'), 'on the second step');
  // The second click of a double click, after the step settled, moves on.
  press(2);
  await settle(frames);
  assert.equal(primary.dataset.firstRunChoice, 'explore', 'on the last step');
  press(2);
  await settle(frames);
  assert.equal(calls, 0);
  assert.equal(root.dataset.state ?? null, null, 'a double click never starts');
  press(1);
  await settle(frames);
  assert.ok(root.dataset.state, 'a single click starts');
});

test('a busy mission marks the choices aria-disabled, never disabled', async (t) => {
  let finish;
  let calls = 0;
  const { root, frames } = await launch(t, {
    dataManager: {
      setEnabled: () => {
        calls++;
        return new Promise((resolve) => (finish = resolve));
      },
    },
  });
  await move(root, frames);
  root.querySelector('[data-first-run-start="space-missions"]').click();
  await nextTick();
  const primary = root.querySelector('[data-first-run-next]');
  primary.click();
  await nextTick();
  const enter = root.querySelector('[data-first-run-primary]');
  assert.equal(
    enter,
    primary,
    'one persistent button keeps native click counting and focus',
  );
  assert.equal(enter.dataset.firstRunChoice, 'space-missions');
  enter.click();
  assert.equal(
    calls,
    0,
    'the new action cannot launch during the step transition',
  );
  // A press begun during the transition and released after it runs nothing.
  enter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await settle(frames);
  enter.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.equal(calls, 0, 'a press held through the step change never launches');
  assert.ok(
    document.activeElement === enter,
    'the primary action retains focus',
  );
  assert.deepEqual(enter.getAttribute('aria-describedby').split(' '), [
    'first-run-title',
    'first-run-description',
  ]);
  const announcement = root.querySelector('.first-run-step-announcement');
  assert.equal(announcement.getAttribute('aria-live'), 'polite');
  assert.equal(announcement.getAttribute('aria-atomic'), 'true');
  assert.equal(
    announcement.textContent,
    root.querySelector('#first-run-title').textContent,
  );
  for (const id of enter.getAttribute('aria-describedby').split(' ')) {
    assert.ok(root.querySelector(`#${id}`).textContent.trim());
  }
  enter.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
  assert.equal(calls, 0, 'a second click from Next never confirms a mission');
  const repeated = new KeyboardEvent('keydown', {
    key: 'Enter',
    repeat: true,
    bubbles: true,
    cancelable: true,
  });
  enter.dispatchEvent(repeated);
  assert.equal(repeated.defaultPrevented, true);
  // A fresh keyboard/assistive click has detail 0 and remains supported.
  enter.click();
  assert.equal(calls, 1);
  await nextTick();
  assert.equal(root.dataset.state, 'loading');
  assert.equal(root.getAttribute('aria-busy'), 'true');
  assert.equal(enter.getAttribute('aria-disabled'), 'true');
  assert.equal(enter.disabled, false);
  assert.ok(document.activeElement === enter, 'focus stays on the action');
  assert.equal(
    root.querySelector('[data-first-run-status]').textContent,
    'Opening space missions…',
  );
  root.querySelector('.first-run-back').click();
  await nextTick();
  assert.equal(
    root.querySelector('[data-first-run-next]'),
    null,
    'Back is inert while busy',
  );
  enter.click();
  assert.equal(calls, 1, 'a busy action cannot start a second request');
  // A failed mission says so and stays on the card.
  finish(false);
  await new Promise((resolve) => setTimeout(resolve));
  await nextTick();
  assert.equal(root.dataset.state, 'ready');
  assert.equal(enter.getAttribute('aria-disabled'), 'false');
  assert.match(
    root.querySelector('[data-first-run-status]').textContent,
    /^Could not open that mission/,
  );
  await move(root, frames, '.first-run-back');
  assert.equal(
    root
      .querySelector('[data-first-run-start="space-missions"]')
      .getAttribute('aria-pressed'),
    'true',
  );
  root.querySelector('.first-run-back').focus();
  await move(root, frames, '.first-run-back');
  assert.equal(root.querySelector('.first-run-back'), null);
  assert.ok(
    document.activeElement === root.querySelector('[data-first-run-primary]'),
    'focus moves when Back is removed',
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

test('the SKIP button closes the card the way ESC does', async (t) => {
  const { root, sessionStorageRef } = await launch(t);
  root.querySelector('[data-first-run-dismiss]').click();
  await nextTick();
  assert.equal(root.classList.contains('visible'), false);
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.notEqual(sessionStorageRef.read(), null, 'dismissed for the session');
  root
    .querySelector('.first-run-step')
    .dispatchEvent(new Event('transitionend', { bubbles: true }));
  await nextTick();
  assert.equal(
    document.getElementById('first-run-launcher'),
    root,
    'child transitions do not finish dismissal',
  );
  root.dispatchEvent(new Event('transitionend'));
  await nextTick();
  assert.equal(document.getElementById('first-run-launcher') === null, true);
});

test('BROWSE STORIES closes the card and opens Stories in place', async (t) => {
  const { root, pinia, frames, sessionStorageRef } = await launch(t);
  const stories = useStoriesStore(pinia);
  let opened = 0;
  let finishLoading;
  stories.connect({
    open: () => {
      opened++;
      return new Promise((resolve) => (finishLoading = resolve));
    },
  });
  await move(root, frames);
  await move(root, frames);
  const button = root.querySelector('[data-first-run-stories]');
  assert.ok(button, 'the Stories card offers its button on the last step');
  assert.equal(button.tagName, 'BUTTON', 'opens in the app, not a new tab');
  assert.equal(button.hasAttribute('href'), false);
  button.click();
  await nextTick();
  assert.equal(opened, 1, 'Stories opened once');
  assert.equal(root.classList.contains('visible'), false, 'the card closed');
  assert.notEqual(sessionStorageRef.read(), null, 'dismissed for the session');
  assert.equal(
    document.body.classList.contains('first-run-opening-stories'),
    true,
    'the Stories announcement stays hidden while Stories loads',
  );
  finishLoading();
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(
    document.body.classList.contains('first-run-opening-stories'),
    false,
    'and may show again once Stories has opened (or failed to)',
  );
  button.dispatchEvent(new MouseEvent('click', { detail: 1 }));
  await nextTick();
  assert.equal(opened, 1, 'a closing card cannot open Stories again');
});

test('BROWSE STORIES keeps the welcome up when Stories refuses to open', async (t) => {
  const { root, pinia, frames, sessionStorageRef } = await launch(t);
  const stories = useStoriesStore(pinia);
  stories.connect({ open: () => false });
  await move(root, frames);
  await move(root, frames);
  root.querySelector('[data-first-run-stories]').click();
  await nextTick();
  assert.equal(root.classList.contains('visible'), true, 'the card stays');
  assert.equal(sessionStorageRef.read(), null, 'not dismissed');
  assert.equal(
    document.body.classList.contains('first-run-opening-stories'),
    false,
  );
});

test('the Stories card is left out where Stories is not offered', async (t) => {
  const { root, pinia, frames } = await launch(t);
  const stories = useStoriesStore(pinia);
  stories.available = false;
  await move(root, frames);
  await move(root, frames);
  assert.equal(root.querySelector('.first-run-stories'), null);
  assert.equal(root.querySelector('[data-first-run-stories]'), null);
});

test('the scroll fade clears when the tiles fit after a resize', async (t) => {
  const { root, list, box, frames } = await launch(t);
  assert.equal(list.dataset.scrollable, 'true');
  box.scrollHeight = 200;
  window.dispatchEvent(new Event('resize'));
  await nextTick();
  assert.equal(list.dataset.scrollable, 'false');
  box.scrollHeight = 400;
  await move(root, frames);
  assert.equal(
    list.dataset.scrollable,
    'true',
    'new step refreshes overflow without a resize',
  );
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
  assert.equal(document.getElementById('first-run-launcher') === null, true);
});
