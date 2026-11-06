// src/overlays/worldOverlayActionsView.test.mjs — the scene chrome's visible
// map target list renders what the world overlay presents and activates the
// target of the list each button belongs to.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useWorldOverlayActionsStore } from '../ui/stores/worldOverlayActions.js';
import SceneChromeView from '../ui/views/SceneChromeView.vue';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useWorldOverlayActionsStore(pinia);
  const app = createApp(SceneChromeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const $ = (selector) => document.querySelector(selector);
  return { store, $ };
}

test('the target list renders each painted action and the last announcement', async (t) => {
  const { store, $ } = mount(t);
  const region = $('#world-overlay-actions');
  assert.equal(region.getAttribute('role'), 'region');
  assert.equal(region.className, 'world-overlay-accessibility');
  assert.equal($('#world-overlay-action-list').children.length, 0);
  assert.equal($('#world-overlay-status').textContent, '');
  const owner = {};
  store.publish({
    owner,
    items: [
      { key: 'vessel\u0000123', label: 'Focus vessel TEST', selected: true },
      { key: 'fire\u000042', label: 'Focus fire 42', selected: false },
    ],
    status: 'Focusing Focus vessel TEST',
    announced: 1,
  });
  await nextTick();
  const buttons = [...$('#world-overlay-action-list').children];
  assert.deepEqual(
    buttons.map((button) => [
      button.type,
      button.textContent,
      button.getAttribute('aria-label'),
      button.getAttribute('aria-pressed'),
      button.dataset.overlayActionKey,
    ]),
    [
      [
        'button',
        'Focus vessel TEST',
        'Focus vessel TEST',
        'true',
        'vessel\u0000123',
      ],
      ['button', 'Focus fire 42', 'Focus fire 42', 'false', 'fire\u000042'],
    ],
  );
  assert.equal(
    $('#world-overlay-status').textContent,
    'Focusing Focus vessel TEST',
  );
});

test('a button activates its own list’s target', async (t) => {
  const { store, $ } = mount(t);
  const calls = [];
  store.connect({ activate: (owner, key) => calls.push([owner, key]) });
  const owner = {};
  store.publish({
    owner,
    items: [{ key: 'a', label: 'Focus A', selected: false }],
    status: '',
  });
  await nextTick();
  $('#world-overlay-action-list button').click();
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0] === owner);
  assert.equal(calls[0][1], 'a');
  store.publish(null);
  await nextTick();
  assert.equal($('#world-overlay-action-list').children.length, 0);
  assert.ok($('#world-overlay-actions'), 'the region itself stays');
});

test('a repeated focus rewrites the status so it is announced again', async (t) => {
  const { store, $ } = mount(t);
  const owner = {};
  const list = (announced) => ({
    owner,
    items: [{ key: 'a', label: 'Focus A', selected: false }],
    status: 'Focusing Focus A',
    announced,
  });
  store.publish(list(1));
  await nextTick();
  const status = $('#world-overlay-status');
  assert.equal(status.textContent, 'Focusing Focus A');
  let writes = 0;
  new MutationObserver((records) => (writes += records.length)).observe(
    status,
    {
      childList: true,
      characterData: true,
      subtree: true,
    },
  );
  store.publish({
    ...list(1),
    items: [{ key: 'a', label: 'Focus A', selected: true }],
  });
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(writes, 0, 'a list change alone announces nothing');
  store.publish(list(2));
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve));
  assert.ok(writes > 0, 'the second focus of the same target is written again');
  assert.equal(status.textContent, 'Focusing Focus A');
});
