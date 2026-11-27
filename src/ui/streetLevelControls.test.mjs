import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { StyleManager } from './applicationShell.js';
import { useContextStore } from './stores/context.js';
import { applicationPinia } from './vueRuntime.js';
import { STREET_LEVEL_PHOTO_EVENT } from './streetLevelEvents.js';
import { StreetLevelControls } from './streetLevelControls.js';
import { installEntityContext } from './entityContextBridge.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { fakeInput } from '../input/testDoubles.mjs';
import { placeStreetLevelViewer } from './streetLevelViewerPlacement.js';
import { useStreetLevelStore } from './stores/streetLevel.js';
import StreetLevelViewer from './views/panels/StreetLevelViewer.vue';
import { createStreetLevelLayer } from '../layers/streetLevel/index.js';
import { createMapillaryProvider } from '../layers/streetLevel/providers/mapillary/index.js';
import { DataLayerManager } from '../data/manager.js';
import { LayerStateCoordinator } from '../data/layerStateCoordinator.js';
import {
  LAYER_STATE_REGISTRY,
  REGISTERED_LAYER_IDS,
  encodeLayerStateParams,
} from '../data/layerState.js';
import {
  fakeCesiumViewer,
  fakeMapillarySource,
  fakePhotoViewer,
  providerSnapshot,
} from '../testSupport/streetLevelFakes.mjs';
import { registerStreetLevelViewerHome } from './streetLevelViewerPlacement.js';

/* ── The photo viewer, mounted on a happy-dom page ─────────────────────── */

/**
 * The street-level photo as Context renders it (StreetLevelViewer.vue), on a
 * page with the Fullscreen API unless `fullscreen` is false, and the Popover
 * API if `popover` is true (iPhone Safari: popovers, no element fullscreen).
 * The layer presents its filters separately on the Data Layers row.
 */
function viewerDom({ fullscreen = true, popover = false } = {}) {
  document.body.replaceChildren();
  document.body.className = '';
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(StreetLevelViewer).use(pinia);
  app.mount(host);
  const store = useStreetLevelStore(pinia);
  const root = document.getElementById('sl-viewer-root');
  const wrap = document.getElementById('sl-viewer-wrap');
  // happy-dom lays nothing out: the viewer has a size, as on a page.
  sized(document.getElementById('sl-viewer'), 640, 400);
  // The browser reports a change after the request settles.
  let fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  const fullscreenTo = (element) => {
    fullscreenElement = element;
    setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), 0);
  };
  document.exitFullscreen = async () => fullscreenTo(null);
  wrap.requestFullscreen = fullscreen ? async () => fullscreenTo(wrap) : null;
  wrap.showPopover = null;
  wrap.hidePopover = null;
  if (popover) {
    // `popover` reflects its attribute, as in the DOM.
    Object.defineProperty(wrap, 'popover', {
      configurable: true,
      get: () => wrap.getAttribute('popover'),
      set: (value) => wrap.setAttribute('popover', value),
    });
    // The browser fires `toggle` after the popover opens or closes.
    const toggleTo = (newState) =>
      setTimeout(() => {
        const event = new Event('toggle');
        event.newState = newState;
        wrap.dispatchEvent(event);
      }, 0);
    wrap.showPopover = () => {
      wrap.popoverOpen = true;
      toggleTo('open');
    };
    wrap.hidePopover = () => {
      wrap.popoverOpen = false;
      toggleTo('closed');
    };
  }
  // Every DOM write the rail's MutationObserver would see.
  const observer = new MutationObserver(() => {});
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    document,
    root,
    wrap,
    store,
    writes: () => observer.takeRecords().length,
    unmount() {
      observer.disconnect();
      app.unmount();
      delete document.fullscreenElement;
    },
  };
}

/** Give an element the layout size happy-dom never computes. */
function sized(element, width, height) {
  for (const [key, value] of [
    ['clientWidth', width],
    ['clientHeight', height],
  ])
    Object.defineProperty(element, key, { configurable: true, value });
}

/** Run `fn` on a fresh page with an immediate animation frame. */
async function withDom(fn, options) {
  const saved = globalThis.requestAnimationFrame;
  const page = viewerDom(options);
  globalThis.requestAnimationFrame = (task) => setTimeout(task, 0);
  try {
    return await fn(page);
  } finally {
    globalThis.requestAnimationFrame = saved;
    page.unmount();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Press a row control as Data Layers does (layerPanel.js `_selectChip`): its
 * own action, else its params as the user's.
 */
function pressRow(row, id, setLayerParams) {
  const control = [...row.chips, ...(row.segmented?.options || [])].find(
    (entry) => entry.id === id,
  );
  assert.ok(control, `row control ${id}`);
  if (control.disabled) return;
  if (typeof control.onClick === 'function') control.onClick();
  else setLayerParams(control.params, { origin: 'user' });
}

/* ── A Street Level layer over a stand-in Mapillary source ─────────────── */

/** Every other registered layer, as a module with no options. */
function plainLayer(id) {
  return {
    id,
    name: id,
    icon: '',
    source: 'test',
    async init() {
      return true;
    },
    async enable() {
      return true;
    },
    async update() {
      return true;
    },
    async disable() {
      return true;
    },
  };
}

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

/** The production path: row → dataManager → layer → durable layer state. */
async function productionLayer(dom) {
  const layer = createStreetLevelLayer({
    providers: [createMapillaryProvider({ source: fakeMapillarySource() })],
  });
  const manager = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS)
    manager.register(id === 'street-level' ? layer : plainLayer(id));
  manager.finalizeRegistrations(LAYER_STATE_REGISTRY);
  const coordinator = new LayerStateCoordinator(
    manager,
    {
      setLayerStateProvider() {},
      onLayerStateChange() {},
    },
    { storage: memoryStorage() },
  );
  await coordinator.start();
  const setLayerParams = (params, options) =>
    manager.setLayerParams('street-level', params, options);
  const controls = new StreetLevelControls({
    root: dom.root,
    layer,
    store: dom.store,
    actions: {
      isEnabled: () => manager.isEnabled('street-level'),
      setEnabled: (on) =>
        manager.setEnabled('street-level', on, { origin: 'user' }),
      setParams: setLayerParams,
      showToast() {},
    },
  });
  controls.connect();
  const share = () => {
    const params = new URLSearchParams([['v', '2']]);
    encodeLayerStateParams(params, coordinator.getDurableState());
    return (params.get('lo') || '').split('_');
  };
  return { layer, manager, coordinator, controls, share, setLayerParams };
}

const TOKEN = LAYER_STATE_REGISTRY.find(
  (entry) => entry.id === 'street-level',
).token;

test('a 360° press on the Data Layers row reaches the share link through the data manager', () =>
  withDom(async (dom) => {
    const { layer, coordinator, controls, share, setLayerParams } =
      await productionLayer(dom);
    pressRow(layer.getRowControls(), 'sl-pano-pano', setLayerParams);
    await settle();
    assert.equal(
      layer.getUIState().filter.pano,
      'pano',
      'the layer applied it',
    );
    assert.equal(
      coordinator.getDurableState().options['street-level'].pano,
      'pano',
      'durable state recorded it',
    );
    assert.ok(share().includes(`${TOKEN}.p.p`), `share link: ${share()}`);
    controls.destroy();
    coordinator.destroy();
  }));

test('the row SINCE slider records the window in the share link', () =>
  withDom(async (dom) => {
    const { layer, coordinator, controls, share, setLayerParams } =
      await productionLayer(dom);
    const slider = layer.getRowControls().slider;
    assert.equal(slider.max, 8, 'one step per SINCE stop');
    setLayerParams(slider.params(5), { origin: 'user' }); // "last year"
    await settle();
    const days =
      coordinator.getDurableState().options['street-level'].sinceDays;
    assert.equal(days, 365, 'a window was recorded');
    assert.ok(share().includes(`${TOKEN}.s.${days}`), `share link: ${share()}`);
    controls.destroy();
    coordinator.destroy();
  }));

test('destroying the controls takes the filters off the layer row', () =>
  withDom(async (dom) => {
    const { layer, coordinator, controls } = await productionLayer(dom);
    assert.ok(layer.getRowControls(), 'presented while attached');
    controls.destroy();
    assert.equal(layer.getRowControls(), null);
    coordinator.destroy();
  }));

/* ── Render behaviour, against a stand-in layer ────────────────────────── */

function stubLayer() {
  const listeners = new Set();
  let state = null;
  let presenter = null;
  const calls = { resize: 0, renderMode: [] };
  return {
    calls,
    /** Notify, then wait for the viewer to render. */
    publish(next) {
      state = next;
      for (const listener of listeners) listener(state);
      return nextTick();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUIState: () => state,
    resizeViewer() {
      calls.resize++;
    },
    setViewerRenderMode(mode) {
      calls.renderMode.push(mode);
    },
    attachViewerHost() {},
    presentRowControls(next) {
      presenter = next;
    },
    /** The Data Layers row as it would render now. */
    row: () => presenter?.() ?? null,
  };
}

function uiState({
  enabled = true,
  on = true,
  open = false,
  pano = 'all',
  renderMode = 'letterbox',
  keyRequired = false,
  imageId = open ? 'img-1' : null,
} = {}) {
  return {
    enabled,
    providers: [providerSnapshot({ on, keyRequired })],
    keyRequired,
    keyRejected: false,
    filter: { pano, sinceDays: 0 },
    coverage: { count: 3, loading: false, hint: '', error: null },
    sequence: { selectedId: null, images: 0, loading: false },
    street: {
      open,
      loading: false,
      renderMode,
      imageId,
      providerId: open ? 'mapillary' : null,
      position: open ? { lat: 30.27, lon: -97.74 } : null,
      error: null,
    },
  };
}

function nearestState() {
  const state = uiState();
  state.providers[0].groundClick = true;
  state.groundClickReady = true;
  return state;
}

test('an app shell without Context still presents Street Level filters, without OPEN', () =>
  withDom(async () => {
    const layer = stubLayer();
    await layer.publish(nearestState());
    layer.attachViewerHost = () => assert.fail('no viewer to attach');
    layer.subscribePhotoViewer = () => assert.fail('no viewer to subscribe');
    const shell = { services: { streetLevelLayer: layer } };
    StyleManager.prototype._initStreetLevelControls.call(shell);
    try {
      assert.ok(
        layer.row().chips.some(({ id }) => id === 'sl-provider-mapillary'),
      );
      assert.ok(layer.row().segmented);
      assert.ok(layer.row().slider);
      assert.ok(!layer.row().chips.some(({ id }) => id === 'sl-open-nearest'));
    } finally {
      shell._streetLevelControls?.destroy();
    }
    assert.equal(layer.row(), null);
  }));

test('choosing Lists supersedes a pending OPEN and leaves later explicit OPEN usable', () =>
  withDom(async (dom) => {
    const context = useContextStore(applicationPinia());
    const previousTab = context.inspectorTab;
    context.setInspectorTab('inspect');
    const layer = stubLayer();
    const initial = nearestState();
    initial.providers[0].billed = true;
    await layer.publish(initial);
    const shell = {
      services: { streetLevelLayer: layer },
      _streetLevelViewer: dom.root,
    };
    const events = [];
    const announced = ({ detail }) => events.push(detail);
    document.addEventListener(STREET_LEVEL_PHOTO_EVENT, announced);
    StyleManager.prototype._initStreetLevelControls.call(shell);
    const pressOpen = () =>
      layer
        .row()
        .chips.find(({ id }) => id === 'sl-open-nearest')
        .onClick();
    const accepted = (n) => ({
      ...initial,
      ...settledPhoto(n),
      groundClickReady: true,
      providers: initial.providers,
      photoRequests: n,
      acceptedPhoto: { ...settledPhoto(n).acceptedPhoto, requestId: n },
    });
    try {
      const pending = Promise.withResolvers();
      let lookupSignal;
      layer.openNearest = (_, { signal }) => {
        lookupSignal = signal;
        return pending.promise;
      };
      const first = pressOpen();
      assert.equal(lookupSignal.aborted, false);
      context.setInspectorTab('lists');
      assert.equal(lookupSignal.aborted, true);
      await layer.publish(accepted(1));
      pending.resolve(true);
      await first;
      assert.deepEqual(events, []);
      context.setInspectorTab('inspect');
      await layer.publish(accepted(1));
      assert.deepEqual(
        events,
        [],
        'returning to Inspector cannot resurrect the old request',
      );

      layer.openNearest = async () => {
        await layer.publish(accepted(2));
        return true;
      };
      await pressOpen();
      assert.deepEqual(
        events.map(({ id, revealFromOpen }) => [id, revealFromOpen]),
        [['mapillary:img-1', true]],
      );
      await layer.publish(accepted(3));
      assert.equal(
        events.at(-1).revealFromOpen,
        undefined,
        'an ordinary photo has no Data Layers OPEN intent',
      );
    } finally {
      shell._streetLevelControls.destroy();
      document.removeEventListener(STREET_LEVEL_PHOTO_EVENT, announced);
      context.setInspectorTab(previousTab);
    }
  }));

test('a delayed row OPEN leaves newer Clean View alone, and a fresh OPEN can reveal its photo', () =>
  withDom(async (dom) => {
    const viewer = { scene: { pick: () => null, drillPick: () => [] } };
    const input = fakeInput(viewer);
    const pinia = applicationPinia();
    const cards = useEntityCardStore(pinia);
    const layer = stubLayer();
    const initial = nearestState();
    const record = {
      id: 'mapillary:img-1',
      name: 'Test photo',
      lat: 47,
      lon: 2,
    };
    layer.getAnalystRecords = () => [record];
    layer.photo = (id) => (id === record.id ? record : null);
    const row = { id: 'street-level', enabled: true, module: layer };
    const manager = {
      isEnabled: (id) => id === row.id,
      layers: new Map([[row.id, row]]),
      getAll: () => [row],
    };
    const shell = {
      services: { streetLevelLayer: layer },
      _dataManager: manager,
      _streetLevelViewer: dom.root,
      setCleanView: StyleManager.prototype.setCleanView,
      toggleCleanView: StyleManager.prototype.toggleCleanView,
      exitContextSelectionView: StyleManager.prototype.exitContextSelectionView,
      contextSelectionCover: StyleManager.prototype.contextSelectionCover,
      _scheduleLeftPanelLayout() {},
    };
    const reveals = [];
    const disconnect = installEntityContext({
      viewer,
      pinia,
      getDataManager: () => manager,
      exitContextSelectionView: (cover) =>
        shell.exitContextSelectionView(cover),
      revealContext: () => reveals.push('context'),
    });
    try {
      await layer.publish(initial);
      StyleManager.prototype._initStreetLevelControls.call(shell);
      const accepted = (requestId) => ({
        ...initial,
        ...settledPhoto(requestId),
        groundClickReady: true,
        providers: initial.providers,
        photoRequests: requestId,
        acceptedPhoto: { ...settledPhoto(requestId).acceptedPhoto, requestId },
      });
      const openWithProvider = async (requestId) => {
        const release = Promise.withResolvers();
        const started = Promise.withResolvers();
        layer.openNearest = async () => {
          await layer.publish({ ...initial, photoRequests: requestId });
          started.resolve();
          await release.promise;
          await layer.publish(accepted(requestId));
          return true;
        };
        const opening = layer
          .row()
          .chips.find(({ id }) => id === 'sl-open-nearest')
          .onClick();
        await started.promise;
        return () => {
          release.resolve();
          return opening;
        };
      };

      const finishOld = await openWithProvider(1);
      shell.setCleanView(true);
      assert.equal(
        await finishOld(),
        true,
        'the accepted photo itself still settles',
      );
      assert.equal(document.body.classList.contains('ui-clean-view'), true);
      assert.equal(cards.card, null);
      assert.deepEqual(reveals, []);

      const finishNew = await openWithProvider(2);
      assert.equal(await finishNew(), true);
      assert.equal(document.body.classList.contains('ui-clean-view'), false);
      assert.equal(cards.card?.identity.id, record.id);
      assert.deepEqual(reveals, ['context']);
    } finally {
      shell._streetLevelControls?.destroy();
      disconnect();
      input.destroy();
      shell.setCleanView(false);
    }
  }));

function settledPhoto(revision, options = {}) {
  const state = uiState({ ...options, open: true });
  const { providerId, imageId, position } = state.street;
  return {
    ...state,
    acceptedPhoto: {
      id: `${providerId}:${imageId}`,
      ...position,
      revision,
      requestId: null,
    },
  };
}

async function stubViewer(dom, state, extraActions = {}) {
  const layer = stubLayer();
  const calls = { setParams: [], setEnabled: [], toasts: [], photos: [] };
  let enabled = state.enabled;
  await layer.publish(state);
  const controls = new StreetLevelControls({
    root: dom.root,
    layer,
    store: dom.store,
    actions: {
      isEnabled: () => enabled,
      setEnabled: async (on) => {
        calls.setEnabled.push(on);
        enabled = on;
      },
      setParams: (params, options) => calls.setParams.push([params, options]),
      showToast: (message) => calls.toasts.push(message),
      showPhoto: (photo) => calls.photos.push(photo),
      ...extraActions,
    },
  });
  controls.connect();
  await nextTick();
  const press = (id) =>
    pressRow(layer.row(), id, (params, options) =>
      calls.setParams.push([params, options]),
    );
  return {
    layer,
    calls,
    controls,
    press,
    chip: (index = 0) => layer.row().chips[index],
  };
}

test('darkening the only lit chip turns the layer off and keeps the provider switched on', () =>
  withDom(async (dom) => {
    const { calls, chip, press, controls } = await stubViewer(dom, uiState());
    assert.equal(chip().id, 'sl-provider-mapillary');
    assert.equal(chip().active, true);
    press('sl-provider-mapillary');
    await settle();
    assert.deepEqual(calls.setEnabled, [false]);
    assert.deepEqual(calls.setParams, [], 'the provider switch is untouched');
    controls.destroy();
  }));

test('lighting a dark chip switches the provider on as a user params request, then the layer', () =>
  withDom(async (dom) => {
    const { calls, chip, press, controls } = await stubViewer(
      dom,
      uiState({ enabled: false, on: false }),
    );
    assert.equal(chip().active, false);
    press('sl-provider-mapillary');
    await settle();
    assert.deepEqual(calls.setParams, [
      [{ mapillary: true }, { origin: 'user' }],
    ]);
    assert.deepEqual(calls.setEnabled, [true]);
    controls.destroy();
  }));

test('under KEY REQUIRED the provider chip stays live and explains the key instead of toggling', () =>
  withDom(async (dom) => {
    const { calls, layer, press, controls } = await stubViewer(
      dom,
      uiState({ keyRequired: true }),
    );
    assert.equal(layer.row().chips[0].disabled, false, 'the chip stays live');
    press('sl-provider-mapillary');
    await settle();
    assert.deepEqual(calls.setEnabled, []);
    assert.deepEqual(calls.setParams, []);
    assert.equal(calls.toasts.length, 1);
    assert.match(calls.toasts[0], /^Mapillary: Needs /);
    controls.destroy();
  }));

test('under KEY REQUIRED the row filters are gated and its line says how to add the key', () =>
  withDom(async (dom) => {
    const { layer, press, calls, controls } = await stubViewer(
      dom,
      uiState({ keyRequired: true }),
    );
    const row = layer.row();
    assert.equal(row.slider, null, 'no SINCE without a key');
    assert.ok(row.segmented.options.every((option) => option.disabled));
    press('sl-pano-pano');
    assert.deepEqual(calls.setParams, [], 'a gated filter does nothing');
    assert.match(row.alert, /^Needs MAPILLARY_CLIENT_TOKEN/);
    controls.destroy();
  }));

test('the viewer is resized once when it opens, not on every render', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubViewer(dom, uiState());
    await settle();
    assert.equal(layer.calls.resize, 0);
    await layer.publish(uiState({ open: true }));
    await settle();
    assert.equal(layer.calls.resize, 1, 'once on open');
    for (let i = 0; i < 5; i++) await layer.publish(uiState({ open: true }));
    await settle();
    assert.equal(layer.calls.resize, 1, 'not again while it stays open');
    await layer.publish(uiState({ open: false }));
    await layer.publish(uiState({ open: true }));
    await settle();
    assert.equal(layer.calls.resize, 2, 'the next photo resizes again');
    controls.destroy();
  }));

test('a photo that closes under focus hands focus to Context, not <body>', () =>
  withDom(async (dom) => {
    let focused = 0;
    const { layer, controls } = await stubViewer(dom, uiState({ open: true }), {
      focusContext: () => focused++,
    });
    dom.root.querySelector('#sl-viewer-expand').focus();
    await layer.publish(uiState({ open: false }));
    assert.equal(dom.wrap.hidden, true);
    assert.equal(focused, 1);
    controls.destroy();
  }));

test('each photo the viewer shows is announced once, so Context opens its card', () =>
  withDom(async (dom) => {
    const { layer, calls, controls } = await stubViewer(dom, uiState());
    await layer.publish(uiState({ open: true, imageId: null }));
    assert.deepEqual(calls.photos, [], 'nothing until its first pose is in');
    const loading = uiState({ open: true });
    loading.street.loading = true;
    await layer.publish(loading);
    assert.deepEqual(
      calls.photos,
      [],
      'a pose before the open settles cannot reclaim Context',
    );

    await layer.publish(settledPhoto(1));
    await layer.publish(settledPhoto(1, { renderMode: 'fill' }));
    assert.deepEqual(calls.photos, [
      {
        id: 'mapillary:img-1',
        lat: 30.27,
        lon: -97.74,
        revision: 1,
        requestId: null,
      },
    ]);
    await layer.publish(settledPhoto(2, { imageId: 'img-2' }));
    assert.deepEqual(
      calls.photos.map((photo) => photo.id),
      ['mapillary:img-1', 'mapillary:img-2'],
      'a step to the next image is announced too',
    );
    await layer.publish(uiState({ open: false }));
    await layer.publish(settledPhoto(3, { imageId: 'img-2' }));
    assert.equal(calls.photos.length, 3, 'the same photo opened again is new');
    controls.destroy();
  }));

/* ── EXPAND is the browser's fullscreen ────────────────────────────────── */

const expandLabel = (dom) => {
  const button = dom.root.querySelector('#sl-viewer-expand');
  return [
    button.querySelector('.sl-btn-text').textContent,
    button.getAttribute('aria-pressed'),
  ];
};

test('EXPAND puts the viewer full screen in place, and the button shrinks it again', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubViewer(dom, uiState({ open: true }));
    await settle();
    const resizes = layer.calls.resize;
    const expand = dom.root.querySelector('#sl-viewer-expand');
    expand.click();
    await settle();
    await settle();
    assertSameNode(dom.document.fullscreenElement, dom.wrap);
    assert.equal(dom.root.contains(dom.wrap), true, 'never leaves its place');
    assert.deepEqual(expandLabel(dom), ['SHRINK', 'true']);
    assert.equal(layer.calls.resize, resizes + 1, 'the viewer refits');
    expand.click();
    await settle();
    await settle();
    assertSameNode(dom.document.fullscreenElement, null);
    assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
    controls.destroy();
  }));

test('Esc in full screen shrinks the photo; Context never sees it', () =>
  withDom(async (dom) => {
    const { controls } = await stubViewer(dom, uiState({ open: true }));
    const expand = dom.root.querySelector('#sl-viewer-expand');
    expand.click();
    await settle();
    await settle();
    assertSameNode(dom.document.fullscreenElement, dom.wrap);
    let contextEsc = 0;
    dom.root.addEventListener('keydown', () => contextEsc++);
    expand.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();
    await settle();
    assertSameNode(dom.document.fullscreenElement, null);
    assert.equal(contextEsc, 0, 'the card stays');
    assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
    // Not expanded, Esc is Context's again.
    expand.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    assert.equal(contextEsc, 1);
    controls.destroy();
  }));

test('an image closed while full screen leaves full screen', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubViewer(dom, uiState({ open: true }));
    dom.root.querySelector('#sl-viewer-expand').click();
    await settle();
    await layer.publish(uiState({ open: false }));
    await settle();
    assertSameNode(dom.document.fullscreenElement, null);
    assert.equal(dom.wrap.hidden, true);
    assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
    controls.destroy();
  }));

test('without the Fullscreen or Popover API there is no EXPAND button', () =>
  withDom(
    async (dom) => {
      const { controls } = await stubViewer(dom, uiState({ open: true }));
      assert.equal(dom.root.querySelector('#sl-viewer-expand').hidden, true);
      controls.destroy();
    },
    { fullscreen: false },
  ));

test('on iPhone (no element fullscreen) EXPAND opens the viewer as a popover over the page', () =>
  withDom(
    async (dom) => {
      const { controls } = await stubViewer(dom, uiState({ open: true }));
      const expand = dom.root.querySelector('#sl-viewer-expand');
      assert.equal(expand.hidden, false, 'offered');
      expand.click();
      await settle();
      await settle();
      assert.equal(dom.wrap.popoverOpen, true);
      assert.equal(dom.root.contains(dom.wrap), true, 'never leaves its place');
      assert.deepEqual(expandLabel(dom), ['SHRINK', 'true']);
      // Esc shrinks the photo; Context's own Esc never sees it.
      let contextEsc = 0;
      dom.root.addEventListener('keydown', () => contextEsc++);
      expand.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await settle();
      await settle();
      assert.equal(dom.wrap.popoverOpen, false);
      assert.equal(contextEsc, 0, 'the card stays');
      assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
      expand.click();
      await settle();
      await settle();
      assert.equal(dom.wrap.popoverOpen, true, 'and opens again');
      expand.click();
      await settle();
      await settle();
      assert.equal(dom.wrap.popoverOpen, false);
      assert.equal(
        dom.wrap.getAttribute('popover'),
        null,
        'a closed popover would be hidden inside the card',
      );
      assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
      controls.destroy();
    },
    { fullscreen: false, popover: true },
  ));

test('destroying the controls while the iPhone popover is open leaves no popover behind', () =>
  withDom(
    async (dom) => {
      const { controls } = await stubViewer(dom, uiState({ open: true }));
      dom.root.querySelector('#sl-viewer-expand').click();
      await settle();
      await settle();
      assert.equal(dom.wrap.getAttribute('popover'), 'auto');
      controls.destroy();
      await settle();
      assert.equal(dom.wrap.popoverOpen, false);
      assert.equal(
        dom.wrap.getAttribute('popover'),
        null,
        'its toggle is not heard any more',
      );
    },
    { fullscreen: false, popover: true },
  ));

/** A MutationObserver stand-in whose callback the test fires. */
function fakeMutationObserver() {
  const observers = new Set();
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
  }
  return {
    FakeObserver,
    observers,
    fire: () => [...observers].forEach((o) => o.callback([])),
  };
}

for (const mode of ['ui-clean-view', 'recording-mode', 'cockpit-mode'])
  test(`entering ${mode} takes the photo out of full screen`, () =>
    withDom(async (dom) => {
      const saved = globalThis.MutationObserver;
      const watch = fakeMutationObserver();
      globalThis.MutationObserver = watch.FakeObserver;
      try {
        const { controls } = await stubViewer(dom, uiState({ open: true }));
        dom.root.querySelector('#sl-viewer-expand').click();
        await settle();
        await settle();
        assertSameNode(dom.document.fullscreenElement, dom.wrap);
        assert.equal(watch.observers.size, 1, 'watching while expanded');
        dom.document.body.classList.toggle(mode, true);
        watch.fire();
        await settle();
        await settle();
        assertSameNode(dom.document.fullscreenElement, null);
        assert.equal(watch.observers.size, 0, 'and not after');
        controls.destroy();
      } finally {
        globalThis.MutationObserver = saved;
      }
    }));

test('in embed mode, which keeps Clean View on for its globe, EXPAND stays; the cockpit still ends it', () =>
  withDom(async (dom) => {
    const saved = globalThis.MutationObserver;
    const watch = fakeMutationObserver();
    globalThis.MutationObserver = watch.FakeObserver;
    try {
      dom.document.body.classList.add('ui-embed');
      dom.document.body.classList.add('ui-clean-view');
      const { layer, controls } = await stubViewer(
        dom,
        uiState({ open: false }),
      );
      await layer.publish(uiState({ open: true }));
      dom.document.querySelector('#sl-viewer-expand').click();
      await settle();
      await settle();
      watch.fire();
      await settle();
      assert.equal(controls.isViewerExpanded(), true, 'EXPAND stays open');
      dom.document.body.classList.toggle('cockpit-mode', true);
      watch.fire();
      await settle();
      await settle();
      assert.equal(controls.isViewerExpanded(), false);
      controls.destroy();
    } finally {
      globalThis.MutationObserver = saved;
    }
  }));

/* ── Rendering and keyboard rules ──────────────────────────────────────── */

test('FIT / FILL show the selected render mode (P3)', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubViewer(dom, uiState({ open: true }));
    await layer.publish(uiState({ open: true, renderMode: 'fill' }));
    const [fit, fill] = dom.wrap.querySelectorAll('[data-sl-render]');
    assert.equal(fill.getAttribute('aria-checked'), 'true');
    assert.equal(fit.getAttribute('aria-checked'), 'false');
    assert.equal(fill.classList.contains('is-active'), true);
    controls.destroy();
  }));

test('arrow keys move FIT / FILL as a radiogroup with one tab stop', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubViewer(dom, uiState({ open: true }));
    const keydown = (target, key) =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key }),
      );
    const [fit, fill] = dom.wrap.querySelectorAll('[data-sl-render]');
    assert.deepEqual(
      [fit, fill].map((button) => button.getAttribute('tabindex')),
      ['0', '-1'],
    );
    fit.focus();
    keydown(fit, 'ArrowRight');
    assertSameNode(dom.document.activeElement, fill);
    assert.deepEqual(layer.calls.renderMode, ['fill']);
    await layer.publish(uiState({ open: true, renderMode: 'fill' }));
    assert.deepEqual(
      [fit, fill].map((button) => button.getAttribute('tabindex')),
      ['-1', '0'],
    );
    controls.destroy();
  }));

test('a hidden (0×0) viewer is not resized, so no z=NaN tile request (P3)', () =>
  withDom(async (dom) => {
    const saved = globalThis.ResizeObserver;
    const observers = [];
    globalThis.ResizeObserver = class {
      constructor(callback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    };
    try {
      const { layer, controls } = await stubViewer(
        dom,
        uiState({ open: true }),
      );
      await settle();
      const resizes = layer.calls.resize;
      const viewer = dom.root.querySelector('#sl-viewer');
      sized(viewer, 0, 0);
      observers[0]();
      await settle();
      assert.equal(layer.calls.resize, resizes, 'skipped while 0×0');
      sized(viewer, 640, 400);
      observers[0]();
      await settle();
      assert.equal(layer.calls.resize, resizes + 1, 'resized once it shows');
      controls.destroy();
    } finally {
      globalThis.ResizeObserver = saved;
    }
  }));

test('identical renders write nothing to the DOM (P3: rail MutationObserver)', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubViewer(dom, uiState({ open: true }));
    await layer.publish(uiState({ open: true }));
    await settle();
    dom.writes();
    for (let i = 0; i < 10; i++) await layer.publish(uiState({ open: true }));
    await settle();
    assert.equal(dom.writes(), 0);
    controls.destroy();
  }));

/* ── The Data Layers row ───────────────────────────────────────────────── */

test('OPEN STREET VIEW on the row opens the nearest panorama at the view centre without moving the camera', () =>
  withDom(async (dom) => {
    const state = uiState();
    state.providers.push({
      ...state.providers[0],
      id: 'google',
      name: 'Google Street View',
      label: 'STREET VIEW',
      groundClick: true,
      count: 0,
    });
    state.groundClickReady = true;
    const { layer, press } = await stubViewer(dom, state);
    const asked = [];
    layer.openNearest = (point, options) => asked.push([point, options]);
    const open = () =>
      layer.row().chips.find((chip) => chip.id === 'sl-open-nearest');
    assert.equal(open().label, 'OPEN STREET VIEW');
    assert.equal(open().action, true, 'an action, not a switch');
    press('sl-open-nearest');
    assert.deepEqual(asked, [
      [
        undefined,
        { providerIds: ['google'], frame: false, aim: 'screen-centre' },
      ],
    ]);
    // Too high to mean a street: disabled, and a press does nothing.
    await layer.publish({ ...state, groundClickReady: false });
    assert.equal(open().disabled, true);
    press('sl-open-nearest');
    assert.equal(asked.length, 1);
    // Off Google 3D the provider is not listed: no button.
    await layer.publish({ ...state, providers: [state.providers[0]] });
    assert.equal(open(), undefined);
  }));

test('a paid open scrolls its viewer into Context before the load and requires a visible intersection', () =>
  withDom(async (dom) => {
    const state = nearestState();
    Object.assign(state.street, { open: true, opening: true, loading: true });
    state.billedPhoto = true;
    const { controls } = await stubViewer(dom, state);
    const rail = document.body.appendChild(document.createElement('div'));
    rail.className = 'global-context-panel-inner';
    const tab = rail.appendChild(document.createElement('div'));
    tab.id = 'context-tab-view';
    tab.appendChild(dom.wrap);
    let top = 200;
    rail.getBoundingClientRect = () => ({
      top: 0,
      bottom: 100,
      left: 0,
      right: 200,
    });
    dom.wrap.getBoundingClientRect = () => ({
      top,
      bottom: top + 50,
      left: 0,
      right: 100,
    });
    try {
      assert.equal(controls._paidPhotoVisible(), false);
      dom.wrap.scrollIntoView = () => {};
      assert.equal(await controls._preparePaidPhoto(null), false);
      dom.wrap.scrollIntoView = () => {
        top = 80;
      };
      assert.equal(await controls._preparePaidPhoto(null), true);
    } finally {
      controls.destroy();
      dom.root.appendChild(dom.wrap);
      rail.remove();
    }
  }));

test('a refused Street View key cannot lock Mapillary out; its chip only explains itself', () =>
  withDom(async (dom) => {
    const state = uiState({ on: false, keyRequired: true });
    state.providers.push({
      ...state.providers[0],
      id: 'google',
      name: 'Google Street View',
      label: 'STREET VIEW',
      on: true,
      keyRequired: true,
      keyRejected: true,
      error: 'Google refused GOOGLE_MAPS_API_KEY for Street View',
    });
    state.providers[0].keyRequired = false;
    const { calls, layer, press } = await stubViewer(dom, state);
    press('sl-provider-mapillary'); // configured, dark
    await settle();
    // One source at a time: lighting Mapillary darkens Street View too.
    assert.deepEqual(calls.setParams, [
      [{ mapillary: true, google: false }, { origin: 'user' }],
    ]);
    // Now dark, the refused chip says why instead of lighting.
    state.providers[0].on = true;
    state.providers[1].on = false;
    state.keyRequired = false;
    await layer.publish({ ...state });
    press('sl-provider-google');
    await settle();
    assert.equal(calls.setParams.length, 1);
    assert.deepEqual(calls.toasts, [layer.row().chips[1].title]);
  }));

test('a swap names every registered provider, also those hidden on this map', () =>
  withDom(async (dom) => {
    const state = uiState({ on: false });
    const { calls, layer, press } = await stubViewer(dom, state);
    // Off Google 3D the Street View chip is not listed, but stays registered.
    layer.providerIds = ['mapillary', 'google'];
    press('sl-provider-mapillary');
    await settle();
    assert.deepEqual(calls.setParams, [
      [{ mapillary: true, google: false }, { origin: 'user' }],
    ]);
  }));

test('the row SINCE reads its window, with the date it compares while one is given', () =>
  withDom(async (dom) => {
    const state = uiState();
    const { layer } = await stubViewer(dom, state);
    const slider = () => layer.row().slider;
    assert.equal(slider().valueText, 'ANY DATE', 'no note for Mapillary');
    assert.deepEqual(slider().params(5), { sinceDays: 365 });
    assert.deepEqual(slider().params(0), { sinceDays: 0 });
    await layer.publish({
      ...state,
      filter: { ...state.filter, sinceDays: 365 },
      sinceNote: '(by upload date)',
    });
    assert.equal(slider().value, 5);
    assert.match(
      slider().valueText,
      /^LAST YEAR · SINCE .* \(by upload date\)$/,
    );
  }));

test('Street View lit hides the imagery filters on the row; Mapillary lit shows them', () =>
  withDom(async (dom) => {
    const state = uiState();
    const { layer } = await stubViewer(dom, state);
    const shown = () => ({
      pano: Boolean(layer.row().segmented),
      since: Boolean(layer.row().slider),
    });
    assert.deepEqual(shown(), { pano: true, since: true });
    await layer.publish({
      ...state,
      filterControls: { pano: false, since: false },
    });
    assert.deepEqual(shown(), { pano: false, since: false });
    await layer.publish(state);
    assert.deepEqual(shown(), { pano: true, since: true });
  }));

test('the row line counts the coverage in view', () =>
  withDom(async (dom) => {
    const { layer } = await stubViewer(dom, uiState());
    assert.match(layer.row().info, /3 sequences in view/);
  }));

/* ── Embed mode ────────────────────────────────────────────────────────── */

/** In embed mode, the viewer moved out of the hidden rail onto the globe. */
const overGlobe = (dom) =>
  dom.wrap.parentNode === dom.document.body &&
  dom.wrap.classList.contains('sl-viewer-wrap-embed');

const escape = () =>
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );

test('in embed mode an open photo leaves the hidden rail for an overlay on the globe, and goes back when it closes', () =>
  withDom(async (dom) => {
    dom.document.body.classList.add('ui-embed');
    const home = dom.wrap.parentNode;
    const after = dom.wrap.nextSibling;
    const { layer, controls } = await stubViewer(dom, uiState({ open: false }));
    assert.equal(overGlobe(dom), false, 'nothing to show yet');
    await layer.publish(uiState({ open: true }));
    assert.equal(overGlobe(dom), true, 'shown over the globe');
    assert.equal(dom.wrap.hidden, false, 'the view still renders it');
    await layer.publish(uiState({ open: true, renderMode: 'fill' }));
    assert.equal(overGlobe(dom), true, 'an update keeps it there');
    assert.equal(
      dom.wrap.querySelector('[aria-checked="true"]')?.textContent.trim(),
      'FILL',
      'and the view keeps patching it there',
    );
    await layer.publish(uiState({ open: false }));
    assert.equal(overGlobe(dom), false);
    assertSameNode(dom.wrap.parentNode, home, 'back where it was');
    assertSameNode(dom.wrap.nextSibling, after, 'in its own place');
    assert.equal(dom.wrap.hidden, true);
    controls.destroy();
  }));

test('outside embed mode a photo stays where Context put it', () =>
  withDom(async (dom) => {
    const home = dom.wrap.parentNode;
    const { layer, controls } = await stubViewer(dom, uiState({ open: false }));
    await layer.publish(uiState({ open: true }));
    assert.equal(overGlobe(dom), false);
    assertSameNode(dom.wrap.parentNode, home);
    controls.destroy();
  }));

test('leaving embed puts the open viewer in the current slot after its original slot is removed', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubViewer(dom, uiState({ open: true }));
    registerStreetLevelViewerHome(dom.root);
    try {
      const addSlot = () => {
        const slot = dom.document.body.appendChild(
          document.createElement('div'),
        );
        slot.id = 'sl-viewer-slot';
        return slot;
      };
      const original = addSlot();
      placeStreetLevelViewer();
      assertSameNode(dom.wrap.parentNode, original);
      dom.document.body.classList.add('ui-embed');
      await layer.publish(uiState({ open: true }));
      assert.equal(overGlobe(dom), true);

      original.remove();
      const current = addSlot();
      dom.document.body.classList.remove('ui-embed');
      const published = layer.publish(uiState({ open: true }));
      assertSameNode(
        dom.wrap.parentNode,
        current,
        'the same wrap reaches the current slot immediately',
      );
      await published;
      assert.equal(dom.wrap.hidden, false);
    } finally {
      registerStreetLevelViewerHome(null);
      controls.destroy();
    }
  }));

test('a passive photo publishes once without switching the phone sheet, and lifts over the globe in embed mode', () =>
  withDom(async (dom) => {
    const revealed = [];
    const { body } = dom.document;
    body.classList.add('mobile-shell');
    body.setAttribute('data-mobile-sheet', 'layers');
    const { layer, calls, controls } = await stubViewer(
      dom,
      uiState({ open: false }),
      {
        revealPanel: () => revealed.push('context'),
      },
    );
    await layer.publish(settledPhoto(1));
    assert.equal(body.getAttribute('data-mobile-sheet'), 'layers');
    assert.equal(overGlobe(dom), false);
    await layer.publish(settledPhoto(1, { renderMode: 'fill' }));
    assert.deepEqual(
      calls.photos.map(({ id }) => id),
      ['mapillary:img-1'],
    );
    assert.deepEqual(revealed, [], 'a passive photo never reveals Context');

    await layer.publish(uiState({ open: false }));
    body.classList.remove('mobile-shell');
    body.removeAttribute('data-mobile-sheet');
    body.classList.add('ui-embed');
    await layer.publish(settledPhoto(2, { imageId: 'img-2' }));
    assert.equal(overGlobe(dom), true, 'embed shows the viewer over the globe');
    assert.deepEqual(
      calls.photos.map(({ id }) => id),
      ['mapillary:img-1', 'mapillary:img-2'],
    );
    assert.deepEqual(revealed, []);
    controls.destroy();
  }));

test('in embed mode Esc closes the photo, and the next photo is shown over the globe again', () =>
  withDom(async (dom) => {
    dom.document.body.classList.add('ui-embed');
    const { layer, controls } = await stubViewer(dom, uiState({ open: false }));
    let closed = 0;
    layer.closeViewer = () => {
      closed++;
      layer.publish(uiState({ open: false }));
    };
    await layer.publish(uiState({ open: true }));
    escape();
    await nextTick();
    assert.equal(closed, 1, 'Esc closed the photo');
    assert.equal(overGlobe(dom), false);
    await layer.publish(uiState({ open: true }));
    assert.equal(overGlobe(dom), true, 'the next photo is shown');
    controls.destroy();
  }));

test('in embed mode Esc in full screen leaves full screen and keeps the photo', () =>
  withDom(async (dom) => {
    dom.document.body.classList.add('ui-embed');
    const { layer, controls } = await stubViewer(dom, uiState({ open: false }));
    let closed = 0;
    layer.closeViewer = () => closed++;
    await layer.publish(uiState({ open: true }));
    await dom.wrap.requestFullscreen();
    await settle();
    assert.equal(controls.isViewerExpanded(), true);
    escape();
    assert.equal(closed, 0, 'the photo stays open');
    controls.destroy();
  }));

test('outside embed mode Esc does not close the photo (Context owns it)', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubViewer(dom, uiState({ open: true }));
    let closed = 0;
    layer.closeViewer = () => closed++;
    escape();
    assert.equal(closed, 0);
    controls.destroy();
  }));

test('destroying the controls in embed mode puts an open photo back', () =>
  withDom(async (dom) => {
    dom.document.body.classList.add('ui-embed');
    const home = dom.wrap.parentNode;
    const { layer, controls } = await stubViewer(dom, uiState({ open: false }));
    await layer.publish(uiState({ open: true }));
    controls.destroy();
    assert.equal(overGlobe(dom), false);
    assertSameNode(dom.wrap.parentNode, home);
  }));

test('a photo failure is shown on the photo itself', () =>
  withDom(async (dom) => {
    dom.document.body.classList.add('ui-embed');
    const { layer, controls } = await stubViewer(dom, uiState({ open: false }));
    const failed = uiState({ open: true });
    Object.assign(failed.street, {
      imageId: null,
      error: 'Image could not be opened',
    });
    await layer.publish(failed);
    assert.equal(overGlobe(dom), true);
    const error = dom.wrap.querySelector('#sl-viewer-error');
    assert.ok(error, 'the photo carries an error region');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /Image could not be opened/);
    await layer.publish(uiState({ open: true }));
    assert.equal(error.hidden, true, 'a successful retry clears the error');
    controls.destroy();
  }));

test('after Context moves the viewer to its home, the controls still bind it and a photo opens', () =>
  withDom(async (dom) => {
    // Context mounts first and takes the viewer out of its root.
    const home = dom.document.body.appendChild(
      dom.document.createElement('div'),
    );
    home.className = 'sl-viewer-home';
    // Context renders the viewer inside its home, then places its wrap.
    home.appendChild(dom.root);
    registerStreetLevelViewerHome(home);
    try {
      assertSameNode(dom.wrap.parentNode, home, 'the viewer moved home');
      assert.equal(dom.root.querySelector('#sl-viewer'), null);
      const photoViewer = fakePhotoViewer({
        pose: { position: { lat: 30.27, lon: -97.74 } },
      });
      const layer = createStreetLevelLayer({
        providers: [
          createMapillaryProvider({
            source: fakeMapillarySource(),
            photoViewer,
          }),
        ],
      });
      const hosts = [];
      const attach = layer.attachViewerHost;
      layer.attachViewerHost = (element) => {
        hosts.push(element);
        attach(element);
      };
      const viewer = fakeCesiumViewer();
      layer.init(viewer);
      layer.enable(viewer);
      const controls = new StreetLevelControls({
        root: dom.root,
        layer,
        store: dom.store,
        actions: {
          isEnabled: () => true,
          setEnabled() {},
          setParams() {},
          showToast() {},
          showPhoto() {},
        },
      });
      controls.connect();
      assertSameNode(hosts[0], dom.document.getElementById('sl-viewer'));
      assert.equal(await layer.openImage('mapillary', 'img1'), true);
      assert.deepEqual(photoViewer.calls.open, ['img1']);
      assert.equal(layer.getUIState().street.error, null);
      // EXPAND binds to the moved viewer too.
      await layer.publish?.(layer.getUIState());
      dom.document.getElementById('sl-viewer-expand').click();
      await settle();
      assert.equal(controls.isViewerExpanded(), true, 'EXPAND works there');
      controls.destroy();
      layer.destroy();
    } finally {
      registerStreetLevelViewerHome(null);
    }
  }));

test('Stories covers a docked photo even while its layout rectangle remains', () =>
  withDom(async (dom) => {
    const layer = stubLayer();
    let canPresent;
    layer.attachDockedPhoto = (_, visible) => {
      canPresent = visible;
    };
    const shell = {
      services: { streetLevelLayer: layer },
      _streetLevelViewer: dom.root,
    };
    const dock = document.body.appendChild(document.createElement('section'));
    dock.className = 'docked-view';
    dock.dataset.kind = 'street';
    dock.getClientRects = () => [{}];
    try {
      StyleManager.prototype._initStreetLevelControls.call(shell);
      assert.equal(canPresent(), true);
      document.body.classList.add('stories-mode');
      assert.equal(canPresent(), false);
      document.body.classList.remove('stories-mode');
      assert.equal(canPresent(), true);
    } finally {
      document.body.classList.remove('stories-mode');
      shell._streetLevelControls?.destroy();
      dock.remove();
    }
  }));

test('the Street Level controls hand dock placement and actions to the owning layer', async () =>
  withDom(async ({ root, store }) => {
    const actions = [];
    const readDock = () => ({
      kind: 'street',
      identity: { id: 'mapillary:a' },
    });
    const canPresent = () => true;
    const controls = new StreetLevelControls({
      root,
      store,
      layer: {
        attachDockedPhoto: (...args) => actions.push(args),
        cancelDockedPhoto: () => actions.push('cancel'),
        stopPlayback: () => actions.push('stop'),
      },
      actions: { dockedPhoto: readDock, dockedPhotoCanPresent: canPresent },
    });
    try {
      controls.connect();
      store.act('cancelDockedPhoto');
      store.act('stopPlayback');
    } finally {
      controls.destroy();
    }
    assert.deepEqual(actions, [
      [readDock, canPresent],
      'cancel',
      'stop',
      [null],
    ]);
  }));
