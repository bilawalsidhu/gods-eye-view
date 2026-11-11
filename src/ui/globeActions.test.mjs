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
import CockpitView from './views/CockpitView.vue';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useGlobeActionsStore(pinia);
  const calls = [];
  const token = store.connect({
    clear: () => calls.push('clear'),
    share: () => calls.push('share'),
    tilt: () => calls.push('tilt'),
    northUp: () => calls.push('northUp'),
    reset: () => calls.push('reset'),
  });
  const app = createApp(GlobeActions).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return { calls, store, token };
}
const $ = (id) => document.getElementById(id);

test('every button calls its owner', (t) => {
  const { calls } = mount(t);
  $('clear-selected-layers').click();
  $('share-btn').click();
  $('tilt-map-view').click();
  $('north-up-view').click();
  $('reset-globe-view').click();
  assert.deepEqual(calls, ['clear', 'share', 'tilt', 'northUp', 'reset']);
});

test('the tilt and compass buttons show the published camera', async (t) => {
  const { store } = mount(t);
  const tilt = $('tilt-map-view');
  const north = $('north-up-view');
  assert.equal(tilt.getAttribute('aria-pressed'), 'false');
  assert.equal(tilt.getAttribute('aria-label'), 'Tilt map to oblique view');
  assert.equal(north.getAttribute('aria-label'), 'Reset map to north up');
  assert.equal(north.hasAttribute('data-north-up'), false);
  assert.equal(north.style.getPropertyValue('--camera-heading'), '');

  store.publishCamera({ tilted: true, heading: 0 });
  await nextTick();
  assert.equal(tilt.getAttribute('aria-pressed'), 'true');
  assert.equal(
    tilt.getAttribute('aria-label'),
    'Return map to straight-down view',
  );
  assert.equal(north.getAttribute('data-north-up'), 'true');
  assert.equal(north.style.getPropertyValue('--camera-heading'), '0deg');

  store.publishCamera({ tilted: false, heading: 47 });
  await nextTick();
  assert.equal(tilt.getAttribute('aria-pressed'), 'false');
  assert.equal(north.getAttribute('data-north-up'), 'false');
  assert.equal(north.style.getPropertyValue('--camera-heading'), '47deg');
  assert.equal(
    north.getAttribute('aria-label'),
    'Reset map to north up. Current heading 47 degrees',
  );

  // A disposed shell hands the next one an unmeasured compass.
  store.publishCamera(null);
  await nextTick();
  assert.equal(north.hasAttribute('data-north-up'), false);
  assert.equal(north.style.getPropertyValue('--camera-heading'), '');
});

test('a clear under way marks the button busy and keeps it focusable', async (t) => {
  const { store, token } = mount(t);
  const clear = $('clear-selected-layers');
  assert.equal(clear.getAttribute('aria-label'), 'Clear selected data layers');
  assert.equal(clear.hasAttribute('aria-busy'), false);
  store.publishClearBusy(token, true);
  await nextTick();
  assert.equal(clear.getAttribute('aria-busy'), 'true');
  assert.equal(clear.getAttribute('aria-disabled'), 'true');
  assert.equal(
    clear.getAttribute('aria-label'),
    'Clearing selected data layers',
  );
  assert.equal(clear.disabled, false);
  store.publishClearBusy(token, false);
  await nextTick();
  assert.equal(clear.getAttribute('aria-busy'), 'false');
  assert.equal(clear.getAttribute('aria-label'), 'Clear selected data layers');
  // The button shows the clear of the owner that answers it: a newer one's,
  // then the older one's again once the newer goes.
  store.publishClearBusy(token, true);
  const newer = store.connect({ clear() {} });
  await nextTick();
  assert.equal(clear.hasAttribute('aria-busy'), false);
  store.publishClearBusy(newer, false);
  await nextTick();
  assert.equal(clear.getAttribute('aria-busy'), 'false');
  store.detach(newer);
  await nextTick();
  assert.equal(clear.getAttribute('aria-busy'), 'true');
  // A shell disposed mid-clear hands the next one a bar that is not busy.
  store.detach(token);
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

test('the same camera state again changes nothing', () => {
  const store = useGlobeActionsStore(createPinia());
  store.publishCamera({ tilted: true, heading: 12 });
  const kept = store.camera;
  store.publishCamera({ tilted: true, heading: 12 });
  assert.equal(store.camera, kept);
  store.publishCamera({ tilted: true, heading: 13 });
  assert.notEqual(store.camera, kept);
  assert.deepEqual(store.camera, { tilted: true, heading: 13 });
});

test('a reset under way relabels the reset button for its owner', async (t) => {
  const { store, token } = mount(t);
  const reset = $('reset-globe-view');
  assert.equal(reset.getAttribute('aria-label'), 'Reset to full globe view');
  store.publishResetting(token, true);
  await nextTick();
  assert.equal(
    reset.getAttribute('aria-label'),
    'Resetting to full globe view',
  );
  assert.equal(store.clearBusy, null, 'a reset is not a clear');
  store.detach(token);
  await nextTick();
  assert.equal(reset.getAttribute('aria-label'), 'Reset to full globe view');
});

test('the cockpit reset asks the reset owner and shows its reset', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useGlobeActionsStore(pinia);
  const calls = [];
  const token = store.connect({ reset: () => calls.push('reset') });
  const app = createApp(CockpitView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const reset = $('cockpit-reset-globe');
  assert.equal(
    reset.getAttribute('aria-label'),
    'Reset cockpit to full globe view',
  );
  reset.click();
  assert.deepEqual(calls, ['reset']);
  store.publishResetting(token, true);
  await nextTick();
  assert.equal(
    reset.getAttribute('aria-label'),
    'Resetting cockpit to full globe view',
  );
});
