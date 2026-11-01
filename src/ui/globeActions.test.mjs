// src/ui/globeActions.test.mjs — the top-center globe actions call their
// owners through the globe actions store, and a clear under way keeps its
// button focusable and marks it busy.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useGlobeActionsStore } from './stores/globeActions.js';
import GlobeActions from './views/panels/GlobeActions.vue';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useGlobeActionsStore(pinia);
  const calls = [];
  store.connect({
    clear: () => calls.push('clear'),
    share: () => calls.push('share'),
  });
  const app = createApp(GlobeActions).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return { calls, store };
}
const $ = (id) => document.getElementById(id);

test('the clear and share buttons call their owners', (t) => {
  const { calls } = mount(t);
  $('clear-selected-layers').click();
  $('share-btn').click();
  assert.deepEqual(calls, ['clear', 'share']);
});

test('a clear under way marks the button busy and keeps it focusable', async (t) => {
  const { store } = mount(t);
  const clear = $('clear-selected-layers');
  assert.equal(clear.getAttribute('aria-label'), 'Clear selected data layers');
  assert.equal(clear.hasAttribute('aria-busy'), false);
  store.publishClearBusy(true);
  await nextTick();
  assert.equal(clear.getAttribute('aria-busy'), 'true');
  assert.equal(clear.getAttribute('aria-disabled'), 'true');
  assert.equal(
    clear.getAttribute('aria-label'),
    'Clearing selected data layers',
  );
  assert.equal(clear.disabled, false);
  store.publishClearBusy(false);
  await nextTick();
  assert.equal(clear.getAttribute('aria-busy'), 'false');
  assert.equal(clear.getAttribute('aria-label'), 'Clear selected data layers');
  // A shell disposed mid-clear hands the next one a bar that is not busy.
  store.publishClearBusy(true);
  store.publishClearBusy(null);
  await nextTick();
  assert.equal(clear.hasAttribute('aria-busy'), false);
  assert.equal(clear.hasAttribute('aria-disabled'), false);
  assert.equal(clear.getAttribute('aria-label'), 'Clear selected data layers');
});

test('a detached owner no longer answers', (t) => {
  const { calls, store } = mount(t);
  const token = store.connect({ share: () => calls.push('newer share') });
  $('share-btn').click();
  store.detach(token);
  $('share-btn').click();
  assert.deepEqual(calls, ['newer share', 'share']);
});
