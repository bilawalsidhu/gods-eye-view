// The Cameras catalog, paging, search and camera walk in Context.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, reactive } from 'vue';
import CameraList from './views/panels/CameraList.vue';
import { useEntityCardStore } from './stores/entityCard.js';
import { useCctvStore } from './stores/cctv.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { contextRadiusKm, setContextRadiusKm } from './contextRadius.js';
import {
  closeContextSearch,
  contextSearchOpen,
  contextSearchText,
} from './contextSearch.js';
import { resetListCardMemory } from './kit/ContextListCard.vue';
import { greatCircleKm } from '../geoDistance.js';
import { CCTV_ACTIVATION_RESULT } from '../cctvFocusRequest.js';
import { createControls } from '../layers/cctv/controls.js';
import { createNavigation } from '../layers/cctv/navigation.js';

// Austin, Texas.
const HERE = { lat: 30.27, lon: -97.74 };

/**
 * The CCTV layer's own controls and navigation over the given cameras, with
 * `picked` listing every camera the layer was asked to make active, in order.
 */
function cctvModule(cameras) {
  const picked = [];
  const records = cameras.map((camera) => ({ camera }));
  const state = {
    _enabled: true,
    _records: records,
    _recordById: new Map(records.map((r) => [r.camera.id, r])),
    _activeCameraId: null,
    _cameraWalk: null,
    _nearbyArea: null,
    _listeners: new Set(),
    _viewer: null,
  };
  const parts = {
    model: {
      eyePose: () => null,
      haversineKm: (lat1, lon1, lat2, lon2) =>
        greatCircleKm({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 }),
    },
    selection: {
      setActiveCamera(id) {
        if (!state._recordById.has(id)) return CCTV_ACTIVATION_RESULT.NOT_FOUND;
        state._activeCameraId = id;
        picked.push(id);
        return CCTV_ACTIVATION_RESULT.ACTIVATED;
      },
    },
    presentation: { notifyListeners() {} },
  };
  const context = {
    state,
    services: {
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
      activation: { CCTV_ACTIVATION_RESULT },
    },
    parts,
    source: {},
  };
  parts.navigation = createNavigation(context);
  return { state, picked, methods: createControls(context).methods };
}

// Cameras north of Austin at growing distances, listed out of order, and one
// in Dallas, outside a 100 km radius.
const step = (i) => ({
  id: `cam${i}`,
  name: `Camera ${i}`,
  city: 'Austin',
  provider: 'TxDOT',
  lat: HERE.lat + i * 0.01,
  lon: HERE.lon,
});
const CAMERAS = [
  step(3),
  step(1),
  {
    id: 'dallas',
    name: 'Dallas cam',
    city: 'Dallas',
    provider: 'TxDOT',
    lat: 32.78,
    lon: -96.8,
  },
  step(5),
  step(2),
  step(4),
];

function cameraView(center, manualInputCount = 0) {
  return {
    center,
    manualInputCount,
    groundFootprint: true,
    heightM: 40_000,
    rect: {
      west: center.lon - 0.5,
      east: center.lon + 0.5,
      south: center.lat - 0.5,
      north: center.lat + 0.5,
    },
  };
}

function fixture(t, cameras = CAMERAS) {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 503 }),
  );
  document.body.replaceChildren();
  resetListCardMemory();
  const radius = contextRadiusKm.value;
  setContextRadiusKm(100);
  const cctv = cctvModule(cameras);
  const layer = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    stats: { count: cameras.length },
    module: cctv.methods,
  };
  const pinia = createPinia();
  const host = document.body.appendChild(document.createElement('div'));
  const list = reactive({ shown: true, hasMatches: false });
  const app = createApp({
    render() {
      return h(CameraList, {
        shown: list.shown,
        onHasMatches: (matches) => (list.hasMatches = matches),
        selected: useEntityCardStore(pinia).card?.identity?.id ?? null,
      });
    },
  }).use(pinia);
  const store = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  const listeners = new Set();
  const manager = {
    layers: new Map([['cctv', layer]]),
    isEnabled: (id) => id === 'cctv' && layer.enabled,
    getAll: () => [layer],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  store.connect({
    dataManager: () => manager,
    flyTo() {},
    canFollow: () => false,
  });
  store.setView(cameraView(HERE));
  store.setViewContextShown(true, 1);
  app.mount(host);
  t.after(() => {
    app.unmount();
    store.setViewContextShown(false, null);
    store.connect(null);
    chrome.detach(owner);
    setContextRadiusKm(radius);
    closeContextSearch();
    contextSearchText.value = '';
  });
  const changeLayers = () =>
    listeners.forEach((listener) => listener({ type: 'visibility' }));
  const names = () =>
    [
      ...document.querySelectorAll(
        '[data-list-card="cctv"] li .nearby-lists__name',
      ),
    ].map((el) => el.textContent);
  const setCollapsed = (collapsed) =>
    chrome.publish(owner, 'global-context-panel', { collapsed });
  return { store, cctv, layer, pinia, changeLayers, names, list, setCollapsed };
}

async function indexReady() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

test('at globe height the Cameras list pages the loaded catalog in source order', async (t) => {
  const { store, names, layer, changeLayers } = fixture(t);
  await indexReady();
  store.setView({ ...cameraView(HERE), heightM: 25_000_000 });
  await nextTick();
  const card = () => document.querySelector('[data-list-card="cctv"]');
  const firstPage = CAMERAS.slice(0, 5).map((camera) => camera.name);
  assert.deepEqual(names(), firstPage);
  assert.equal(card().querySelector('h4 strong').textContent.trim(), '6');
  assert.match(card().querySelector('li').textContent, /Austin · TxDOT/);
  assert.doesNotMatch(card().querySelector('li').textContent, /km/);

  const reads = t.mock.method(layer.module, 'getInspectorContextPoints');
  setContextRadiusKm(25);
  store.setView({ ...cameraView({ lat: 0, lon: 0 }), heightM: 25_000_000 });
  card().querySelector('[data-list-next]').click();
  await nextTick();
  assert.deepEqual(names(), ['Camera 4']);
  assert.equal(reads.mock.callCount(), 0);
  card().querySelector('[data-list-previous]').click();
  await nextTick();
  assert.deepEqual(names(), firstPage);

  layer.stats = { ...layer.stats, lastUpdate: 1 };
  changeLayers();
  await nextTick();
  assert.equal(reads.mock.callCount(), 1);
});

test('below globe height the list is the cameras in view, nearest first, with their distance', async (t) => {
  const { store, names } = fixture(t);
  await indexReady();
  const card = () => document.querySelector('[data-list-card="cctv"]');
  const scope = () =>
    card().querySelector('[data-list-scope]')?.textContent.trim();
  // Dallas is loaded but out of view.
  assert.deepEqual(names(), [
    'Camera 1',
    'Camera 2',
    'Camera 3',
    'Camera 4',
    'Camera 5',
  ]);
  assert.equal(card().querySelector('h4 strong').textContent.trim(), '5');
  assert.equal(scope(), 'In view · 6 loaded');
  assert.match(
    card().querySelector('li .nearby-lists__meta').textContent,
    /km/,
  );
  assert.equal(
    card().querySelector('.view-context__bar-key').textContent.trim(),
    'TxDOT 5',
  );
  // A moving camera keeps the list until the view settles.
  const empty = { lat: 29, lon: HERE.lon };
  store.setView(cameraView(empty), { settled: false });
  await nextTick();
  assert.equal(names()[0], 'Camera 1');
  assert.equal(scope(), 'In view · 6 loaded');
  // Settled with nothing in view: the three closest.
  store.setView(cameraView(empty));
  await nextTick();
  assert.deepEqual(names(), ['Camera 1', 'Camera 2', 'Camera 3']);
  assert.equal(scope(), 'Closest to view · 6 loaded');
  // At globe height, the whole catalog in source order, with no distance.
  store.setView({ ...cameraView(HERE), heightM: 25_000_000 });
  await nextTick();
  assert.deepEqual(
    names(),
    CAMERAS.slice(0, 5).map((camera) => camera.name),
  );
  assert.equal(card().querySelector('h4 strong').textContent.trim(), '6');
  assert.equal(card().querySelector('[data-list-scope]'), null);
  assert.equal(card().querySelector('li .nearby-lists__meta'), null);
});

test('the list searches the complete catalog and reports no matches', async (t) => {
  const { names, list } = fixture(t);
  contextSearchOpen.value = true;
  contextSearchText.value = 'camera 4';
  await indexReady();
  assert.deepEqual(names(), ['Camera 4']);
  assert.equal(list.hasMatches, true);
  contextSearchText.value = 'dallas';
  await nextTick();
  assert.deepEqual(names(), ['Dallas cam']);
  assert.match(
    document.querySelector('[data-list-scope]').textContent,
    /6 loaded/,
  );
  contextSearchText.value = 'txdot';
  await nextTick();
  assert.equal(names().length, 5);
  contextSearchText.value = 'zzz';
  await nextTick();
  assert.deepEqual(names(), []);
  assert.equal(list.hasMatches, false);
  assert.match(
    document.querySelector('.context-list-card__state').textContent,
    /Nothing matches “zzz”/,
  );
});

test('a camera city filters the cameras in view and resets paging and the walk', async (t) => {
  const { cctv, list, names } = fixture(t, [
    ...CAMERAS,
    { ...step(6), city: 'Global' },
    { ...step(7), city: '' },
  ]);
  await indexReady();
  const card = () => document.querySelector('[data-list-card="cctv"]');
  const chips = () => [...card().querySelectorAll('button[aria-pressed]')];
  const chip = (name) =>
    chips().find((button) => button.textContent.trim() === name);
  assert.deepEqual(
    chips().map((button) => button.textContent.trim()),
    ['All', 'Austin'],
  );
  card().querySelector('[data-list-next]').click();
  await nextTick();
  assert.deepEqual(names(), ['Camera 6', 'Camera 7']);
  chip('Austin').click();
  await nextTick();
  assert.deepEqual(names(), [
    'Camera 1',
    'Camera 2',
    'Camera 3',
    'Camera 4',
    'Camera 5',
  ]);
  assert.deepEqual(cctv.state._nearbyArea.order, [
    'cam1',
    'cam2',
    'cam3',
    'cam4',
    'cam5',
  ]);

  contextSearchOpen.value = true;
  contextSearchText.value = 'dallas';
  await nextTick();
  assert.deepEqual(names(), []);
  assert.equal(list.hasMatches, false);
  assert.ok(
    chip('Dallas'),
    'matching cities stay available despite the Austin chip',
  );
  assert.equal(chip('Austin').getAttribute('aria-pressed'), 'true');
  contextSearchText.value = 'missing';
  await nextTick();
  assert.deepEqual(
    chips().map((button) => button.textContent.trim()),
    ['All', 'Austin'],
  );
  contextSearchText.value = 'dallas';
  await nextTick();
  chip('All').click();
  await nextTick();
  assert.deepEqual(names(), ['Dallas cam']);
  assert.deepEqual(
    chips().map((button) => button.textContent.trim()),
    ['All', 'Dallas'],
  );
  assert.equal(list.hasMatches, true);
  assert.deepEqual(cctv.state._nearbyArea.order, ['dallas']);
});

test('the settled catalog page remains in place while its source refreshes', async (t) => {
  const { cctv, layer, changeLayers, names, store } = fixture(t);
  await indexReady();
  store.setView({ ...cameraView(HERE), heightM: 25_000_000 });
  await nextTick();
  const card = document.querySelector('[data-list-card="cctv"]');
  card.querySelector('[data-list-next]').click();
  await nextTick();
  const row = card.querySelector('[data-list-key="cam4"]');
  row.focus();

  cctv.state._records = [];
  layer.stats = { count: 0, loading: true };
  changeLayers();
  await nextTick();
  assert.deepEqual(names(), ['Camera 4']);
  assert.equal(document.activeElement, row);

  const refreshed = CAMERAS.map((camera) => ({ camera }));
  refreshed[5].camera = { ...refreshed[5].camera, name: 'Camera 4 updated' };
  cctv.state._records = refreshed;
  layer.stats = { count: refreshed.length, lastUpdate: 1 };
  changeLayers();
  await nextTick();
  assert.deepEqual(names(), ['Camera 4 updated']);
  assert.equal(document.activeElement, row);
});

test('an empty camera catalog distinguishes loading, unavailable and ready', async (t) => {
  const { layer, changeLayers } = fixture(t, []);
  const state = () =>
    document
      .querySelector('[data-list-card="cctv"] .context-list-card__state')
      ?.textContent.trim();
  const dot = () =>
    document.querySelector('.context-list-card__head .view-context__dot');
  layer.stats = { count: 0, loading: true };
  changeLayers();
  await nextTick();
  assert.equal(state(), 'Loading');
  assert.ok(dot().classList.contains('view-context__dot--loading'));
  assert.equal(dot().getAttribute('aria-label'), 'Loading');
  layer.stats = { count: 0, error: 'camera feed failed' };
  changeLayers();
  await nextTick();
  assert.equal(state(), 'Unavailable');
  assert.ok(dot().classList.contains('view-context__dot--unavailable'));
  assert.equal(dot().getAttribute('aria-label'), 'Unavailable');
  layer.stats = { count: 0 };
  changeLayers();
  await nextTick();
  assert.equal(state(), '0 results');
  assert.ok(dot().classList.contains('view-context__dot--nominal'));
});

test('a row opens the camera on Inspect: the camera is picked and its card shows', async (t) => {
  const { store, cctv } = fixture(t);
  await indexReady();
  document
    .querySelector('[data-list-card="cctv"] [data-list-key="cam2"]')
    .click();
  await nextTick();
  assert.deepEqual(
    cctv.picked,
    ['cam2'],
    'picked in the layer, as a click on the globe picks it',
  );
  assert.equal(store.card?.key, 'cctv:cam2');
  assert.ok(document.querySelector('[data-list-card="cctv"] #entity-card'));
});

test('an active video camera is live in the catalog only while its surface plays', async (t) => {
  const { pinia } = fixture(t);
  const video = useCctvStore(pinia);
  video.publish({ activeCameraId: 'cam2' });
  video.setLive(true);
  for (const [state, label] of [
    ['', 'Paused'],
    ['waiting', 'Paused'],
    ['playing', 'Live'],
    ['stalled', 'Paused'],
  ]) {
    video.setLiveState(state);
    await nextTick();
    const dot = document.querySelector(
      '[data-list-key="cam2"] .view-context__dot',
    );
    assert.equal(dot.getAttribute('aria-label'), label);
    assert.equal(
      dot.classList.contains('view-context__dot--nominal'),
      state === 'playing',
    );
  }
});

test('hiding a selected camera unmounts its detail and showing it restores the same pick', async (t) => {
  const { list, store, cctv } = fixture(t);
  await indexReady();
  document.querySelector('[data-list-key="cam2"]').click();
  await nextTick();
  assert.ok(document.querySelector('#entity-card'));
  list.shown = false;
  await nextTick();
  assert.equal(Boolean(document.querySelector('#entity-card')), false);
  assert.equal(store.card.key, 'cctv:cam2');
  list.shown = true;
  await nextTick();
  assert.ok(document.querySelector('#entity-card'));
  assert.deepEqual(cctv.picked, ['cam2']);
});

test('a row opened from the keyboard hands focus to the card that replaces the list', async (t) => {
  const { store } = fixture(t);
  await indexReady();
  const row = document.querySelector(
    '[data-list-card="cctv"] button[data-list-key="cam2"]',
  );
  row.focus();
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await nextTick();
  await nextTick();
  assert.equal(store.card?.key, 'cctv:cam2');
  const close = document.querySelector(
    '[data-list-card="cctv"] h4 [data-list-back]',
  );
  assert.equal(document.activeElement, close);
  assert.ok(close.closest('.camera-list--detail'));
  assert.equal(
    document.querySelectorAll(
      '[data-list-card="cctv"] [data-list-back], [data-list-card="cctv"] .entity-card__close',
    ).length,
    1,
  );
  assert.equal(
    document.querySelector('[data-list-card="cctv"] h4 strong'),
    null,
  );
  close.click();
  await nextTick();
  await nextTick();
  assert.equal(document.activeElement?.dataset.listKey, 'cam2');
  assert.ok(!document.querySelector('.camera-list--detail'));
});

for (const [name, changeView, keepsOrder] of [
  [
    'manual move',
    (store, center) => store.setView(cameraView(center, 1)),
    false,
  ],
  ['view command', (store) => store.noteViewCommand(), true],
]) {
  test(`closing a camera returns to its page and row across a ${name}`, async (t) => {
    const cameras = Array.from({ length: 11 }, (_, i) => step(i + 1));
    const { store } = fixture(t, cameras);
    const card = () => document.querySelector('[data-list-card="cctv"]');
    const keys = () =>
      [...card().querySelectorAll('[data-list-key]')].map(
        (row) => row.dataset.listKey,
      );
    await indexReady();
    card().querySelector('[data-list-next]').click();
    await nextTick();
    const before = keys();
    const row = card().querySelector('[data-list-key="cam7"]');
    row.focus();
    row.click();
    await nextTick();
    await nextTick();
    assert.equal(store.card?.key, 'cctv:cam7');
    // A settled flight changes the centre without new manual camera input.
    store.setView(cameraView(cameras[6]));
    await nextTick();
    card().querySelector('[data-list-back]').click();
    await nextTick();
    await nextTick();
    assert.deepEqual(keys(), before);
    assert.equal(document.activeElement?.dataset.listKey, 'cam7');
    changeView(store, cameras[6]);
    await nextTick();
    if (keepsOrder) assert.deepEqual(keys(), before);
    else
      assert.notDeepEqual(
        keys(),
        before,
        'a deliberate move re-sorts the list around the new centre',
      );
  });
}

test('Prev/Next walk the same list in the same order', async (t) => {
  const { cctv } = fixture(t);
  await indexReady();
  const nameOf = (id) => CAMERAS.find((camera) => camera.id === id).name;
  const next = cctv.methods
    .getRowControls()
    .chips.find((chip) => chip.id === 'next-camera');
  const walked = [];
  for (let i = 0; i < CAMERAS.length; i += 1) {
    next.onClick();
    walked.push(nameOf(cctv.picked.at(-1)));
  }
  assert.deepEqual(walked, [
    'Camera 1',
    'Camera 2',
    'Camera 3',
    'Camera 4',
    'Camera 5',
    'Camera 1',
  ]);
});

test('Prev/Next and auto-hop get the order the card lists, searched', async (t) => {
  const { cctv } = fixture(t);
  await indexReady();
  assert.deepEqual(cctv.state._nearbyArea.order, [
    'cam1',
    'cam2',
    'cam3',
    'cam4',
    'cam5',
  ]);
  contextSearchOpen.value = true;
  contextSearchText.value = 'camera 4';
  await indexReady();
  await nextTick();
  assert.deepEqual(cctv.state._nearbyArea.order, ['cam4']);
});

test("auto-hop ignores a hidden list's search", async (t) => {
  const { cctv, list } = fixture(t);
  contextSearchOpen.value = true;
  contextSearchText.value = 'camera 4';
  await indexReady();
  await nextTick();
  assert.deepEqual(cctv.state._nearbyArea.order, ['cam4']);
  // Inspect, Pinned, another list or a closed phone sheet hides it.
  list.shown = false;
  await nextTick();
  await nextTick();
  assert.equal(
    cctv.state._nearbyArea.order,
    null,
    'no order from a hidden list',
  );
  assert.equal(
    cctv.methods.stepNearbyCamera(1, { focus: false })?.cameraId,
    'cam1',
    'the walk takes the whole radius, not the hidden search',
  );
});

test('a new search restarts the walk; a recentre keeps it', async (t) => {
  const { cctv, store } = fixture(t);
  await indexReady();
  const step = () =>
    cctv.methods.stepNearbyCamera(1, { focus: false })?.cameraId;
  assert.equal(step(), 'cam1');
  // Recentring keeps the walk going from where it is.
  store.setView(cameraView({ lat: HERE.lat + 0.001, lon: HERE.lon }));
  await nextTick();
  await nextTick();
  assert.equal(step(), 'cam2', 'the walk goes on after a recentre');
  // A search that drops the next camera starts a walk over what shows.
  contextSearchOpen.value = true;
  contextSearchText.value = 'camera';
  await nextTick();
  await nextTick();
  const shown = cctv.state._nearbyArea.order;
  assert.equal(
    cctv.state._cameraWalk,
    null,
    'the search change dropped the walk',
  );
  assert.equal(step(), shown[(shown.indexOf('cam2') + 1) % shown.length]);
});

test('long lists show a page at a time, with a breakdown by provider', async (t) => {
  const many = Array.from({ length: 12 }, (_, i) => step(i / 100));
  fixture(t, many);
  await indexReady();
  const card = () => document.querySelector("[data-list-card='cctv']");
  const rows = () => card().querySelectorAll('li').length;
  assert.equal(rows(), 5);
  assert.ok(card().querySelector('.view-context__bar'), 'the provider bar');
  card().querySelector('[data-list-next]').click();
  await nextTick();
  assert.equal(rows(), 5);
  assert.match(card().querySelector('[data-list-range]').textContent, /6–10/);
});

test('the inline list goes when Cameras turns off', async (t) => {
  const { layer, changeLayers, cctv } = fixture(t);
  await indexReady();
  assert.ok(document.querySelector('[data-list-card="cctv"]'));
  // Prev/Next walk this list: with no view to go by, a step takes its nearest.
  assert.equal(
    cctv.methods.stepNearbyCamera(1, { focus: false })?.cameraId,
    'cam1',
    'Prev/Next walk this list',
  );
  layer.enabled = false;
  cctv.state._enabled = false;
  changeLayers();
  await nextTick();
  assert.equal(document.querySelector('[data-list-card="cctv"]'), null);
  // The list let go of the walk: with no view either, a new walk finds nothing.
  cctv.state._enabled = true;
  cctv.state._activeCameraId = null;
  assert.equal(cctv.methods.stepNearbyCamera(1, { focus: false }), null);
});

test('closing Context drops the visible Cameras search walk', async (t) => {
  const { cctv, list, names, setCollapsed } = fixture(t, [
    { ...step(1), name: 'Pair north' },
    step(2),
    { ...step(3), name: 'Pair south' },
  ]);
  contextSearchOpen.value = true;
  contextSearchText.value = 'pair';
  await indexReady();
  await indexReady();
  assert.deepEqual(names(), ['Pair north', 'Pair south']);
  const next = cctv.methods
    .getRowControls()
    .chips.find((chip) => chip.id === 'next-camera');
  next.onClick();
  assert.deepEqual(cctv.picked, ['cam1']);

  setCollapsed(true);
  list.shown = false;
  await nextTick();
  await nextTick();
  assert.equal(cctv.state._nearbyArea, null);
  next.onClick();
  assert.deepEqual(cctv.picked, ['cam1', 'cam2']);
});

test('closing Context drops a walk of its hidden list', async (t) => {
  const { cctv, list, setCollapsed } = fixture(t, [step(1), step(2), step(3)]);
  list.shown = false;
  await nextTick();
  await nextTick();
  const area = cctv.state._nearbyArea;
  assert.ok(area);
  assert.equal(area.order, null);
  const next = cctv.methods
    .getRowControls()
    .chips.find((chip) => chip.id === 'next-camera');
  next.onClick();
  assert.ok(cctv.state._cameraWalk);

  setCollapsed(true);
  await nextTick();
  await nextTick();
  assert.equal(cctv.state._nearbyArea, null);
  assert.equal(cctv.state._cameraWalk, null);
});
