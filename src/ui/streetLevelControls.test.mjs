import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import fs from 'node:fs';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { StreetLevelControls } from './streetLevelControls.js';
import { useStreetLevelStore } from './stores/streetLevel.js';
import StreetLevelPanel from './views/panels/StreetLevelPanel.vue';
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
  fakeMapillarySource,
  providerSnapshot,
} from '../testSupport/streetLevelFakes.mjs';

/* ── The panel view, mounted on a happy-dom page ───────────────────────── */

/**
 * The Street Level panel as the page renders it, on a page with the
 * Fullscreen API unless `fullscreen` is false, and the Popover API if
 * `popover` is true (iPhone Safari: popovers, no element fullscreen).
 */
function panelDom({ fullscreen = true, popover = false } = {}) {
  document.body.replaceChildren();
  document.body.className = '';
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(StreetLevelPanel).use(pinia);
  app.mount(host);
  const store = useStreetLevelStore(pinia);
  const root = document.getElementById('street-level-panel');
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

/** Run `fn` on a fresh panel with an immediate animation frame. */
async function withDom(fn, options) {
  const saved = globalThis.requestAnimationFrame;
  const page = panelDom(options);
  globalThis.requestAnimationFrame = (task) => setTimeout(task, 0);
  try {
    return await fn(page);
  } finally {
    globalThis.requestAnimationFrame = saved;
    page.unmount();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

/** The production path: controls → dataManager → layer → durable layer state. */
async function productionPanel(dom) {
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
  const controls = new StreetLevelControls({
    root: dom.root,
    layer,
    store: dom.store,
    actions: {
      isEnabled: () => manager.isEnabled('street-level'),
      setEnabled: (on) =>
        manager.setEnabled('street-level', on, { origin: 'user' }),
      setParams: (params, options) =>
        manager.setLayerParams('street-level', params, options),
      setPanelCollapsed() {},
      showToast() {},
      subscribeEnableRequests: () => () => {},
    },
  });
  controls.connect();
  const share = () => {
    const params = new URLSearchParams([['v', '2']]);
    encodeLayerStateParams(params, coordinator.getDurableState());
    return (params.get('lo') || '').split('_');
  };
  return { layer, manager, coordinator, controls, share };
}

const TOKEN = LAYER_STATE_REGISTRY.find(
  (entry) => entry.id === 'street-level',
).token;

test('a 360° click reaches the share link through the data manager', () =>
  withDom(async (dom) => {
    const { layer, coordinator, controls, share } = await productionPanel(dom);
    dom.root.querySelectorAll('[data-sl-pano]')[1].click(); // 360°
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

test('releasing the SINCE slider records the window in the share link', () =>
  withDom(async (dom) => {
    const { coordinator, controls, share } = await productionPanel(dom);
    const since = dom.root.querySelector('#sl-since');
    since.value = '5'; // the "last year" stop
    since.dispatchEvent(new Event('change'));
    await settle();
    const days =
      coordinator.getDurableState().options['street-level'].sinceDays;
    assert.ok(days > 0, 'a window was recorded');
    assert.ok(share().includes(`${TOKEN}.s.${days}`), `share link: ${share()}`);
    controls.destroy();
    coordinator.destroy();
  }));

/* ── Render behaviour, against a stand-in layer ────────────────────────── */

function stubLayer() {
  const listeners = new Set();
  let state = null;
  const calls = { resize: 0 };
  return {
    calls,
    /** Notify, then wait for the panel to render. */
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
    attachViewerHost() {},
  };
}

function uiState({
  enabled = true,
  on = true,
  open = false,
  pano = 'all',
  renderMode = 'letterbox',
  keyRequired = false,
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
      imageId: open ? 'img-1' : null,
      error: null,
    },
  };
}

async function stubPanel(dom, state, extraActions = {}) {
  const layer = stubLayer();
  const calls = { setParams: [], setEnabled: [], collapsed: [], toasts: [] };
  let enabled = state.enabled;
  /** Reports a switch-on request's origin, as the data manager does. */
  let announce = null;
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
      setPanelCollapsed: (collapsed, options) =>
        calls.collapsed.push([collapsed, options]),
      showToast: (message) => calls.toasts.push(message),
      subscribeEnableRequests: (listener) => {
        announce = listener;
        return () => {
          announce = null;
        };
      },
      ...extraActions,
    },
  });
  controls.connect();
  await nextTick();
  return {
    layer,
    calls,
    controls,
    announce: (origin) => announce?.(origin),
    subscribed: () => announce !== null,
    chip: () => dom.root.querySelector('#sl-provider-chips').children[0],
  };
}

test('the header pill switches the layer; provider switches are left alone', () =>
  withDom(async (dom) => {
    const status = dom.root.querySelector('#sl-status');
    const { calls, controls } = await stubPanel(dom, uiState());
    status.click();
    await settle();
    assert.deepEqual(calls.setEnabled, [false]);
    assert.deepEqual(calls.setParams, []);
    controls.destroy();
  }));

test('darkening the only lit chip turns the layer off and keeps the provider switched on', () =>
  withDom(async (dom) => {
    const { calls, chip, controls } = await stubPanel(dom, uiState());
    assert.equal(chip().dataset.chipId, 'mapillary');
    assert.equal(chip().getAttribute('aria-pressed'), 'true');
    chip().click();
    await settle();
    assert.deepEqual(calls.setEnabled, [false]);
    assert.deepEqual(calls.setParams, [], 'the provider switch is untouched');
    controls.destroy();
  }));

test('lighting a dark chip switches the provider on as a user params request, then the layer', () =>
  withDom(async (dom) => {
    const { calls, chip, controls } = await stubPanel(
      dom,
      uiState({ enabled: false, on: false }),
    );
    assert.equal(chip().getAttribute('aria-pressed'), 'false');
    chip().click();
    await settle();
    assert.deepEqual(calls.setParams, [
      [{ mapillary: true }, { origin: 'user' }],
    ]);
    assert.deepEqual(calls.setEnabled, [true]);
    controls.destroy();
  }));

test('under KEY REQUIRED the provider chip stays live and explains the key instead of toggling', () =>
  withDom(async (dom) => {
    const { calls, chip, controls } = await stubPanel(
      dom,
      uiState({ keyRequired: true }),
    );
    assert.equal(
      dom.root.querySelector('#sl-controls').contains(chip()),
      false,
      'the chip is outside the disabled fieldset',
    );
    chip().click();
    await settle();
    assert.deepEqual(calls.setEnabled, []);
    assert.deepEqual(calls.setParams, []);
    assert.equal(calls.toasts.length, 1);
    assert.match(calls.toasts[0], /^Mapillary: Needs /);
    controls.destroy();
  }));

test('under KEY REQUIRED the filters are gated and the error line says how to add the key', () =>
  withDom(async (dom) => {
    const { controls } = await stubPanel(dom, uiState({ keyRequired: true }));
    assert.equal(dom.root.querySelector('#sl-controls').disabled, true);
    assert.equal(dom.root.querySelector('#sl-error').hidden, false);
    assert.match(
      dom.root.querySelector('#sl-error-text').textContent,
      /^Needs MAPILLARY_CLIENT_TOKEN/,
    );
    controls.destroy();
  }));

test('the viewer is resized once when it opens, not on every render', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubPanel(dom, uiState());
    await settle();
    assert.equal(layer.calls.resize, 0);
    await layer.publish(uiState({ open: true }));
    await settle();
    // Opening also opens the panel; the two share one coalesced resize.
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

test('closing the image from its × button leaves focus on the panel, not <body>', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubPanel(dom, uiState({ open: true }));
    dom.root.querySelector('#sl-viewer-close').focus();
    await layer.publish(uiState({ open: false }));
    assert.equal(dom.wrap.hidden, true);
    assertSameNode(
      dom.document.activeElement,
      dom.root.querySelector('#sl-status'),
    );
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
    const { layer, controls } = await stubPanel(dom, uiState({ open: true }));
    await settle();
    const resizes = layer.calls.resize;
    const expand = dom.root.querySelector('#sl-viewer-expand');
    expand.click();
    await settle();
    await settle();
    assertSameNode(dom.document.fullscreenElement, dom.wrap);
    assert.equal(dom.root.contains(dom.wrap), true, 'never leaves the panel');
    assert.deepEqual(expandLabel(dom), ['SHRINK', 'true']);
    assert.equal(layer.calls.resize, resizes + 1, 'the viewer refits');
    expand.click();
    await settle();
    await settle();
    assertSameNode(dom.document.fullscreenElement, null);
    assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
    controls.destroy();
  }));

test('Esc in full screen shrinks the photo; the panel never sees it', () =>
  withDom(async (dom) => {
    const { controls } = await stubPanel(dom, uiState({ open: true }));
    const expand = dom.root.querySelector('#sl-viewer-expand');
    expand.click();
    await settle();
    await settle();
    assertSameNode(dom.document.fullscreenElement, dom.wrap);
    let panelEsc = 0;
    dom.root.addEventListener('keydown', () => panelEsc++);
    expand.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();
    await settle();
    assertSameNode(dom.document.fullscreenElement, null);
    assert.equal(panelEsc, 0, 'the panel stays open');
    assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
    // Not expanded, Esc is the panel's again.
    expand.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    assert.equal(panelEsc, 1);
    controls.destroy();
  }));

test('an image closed while full screen leaves full screen', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubPanel(dom, uiState({ open: true }));
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
      const { controls } = await stubPanel(dom, uiState({ open: true }));
      assert.equal(dom.root.querySelector('#sl-viewer-expand').hidden, true);
      controls.destroy();
    },
    { fullscreen: false },
  ));

test('on iPhone (no element fullscreen) EXPAND opens the viewer as a popover over the page', () =>
  withDom(
    async (dom) => {
      const { controls } = await stubPanel(dom, uiState({ open: true }));
      const expand = dom.root.querySelector('#sl-viewer-expand');
      assert.equal(expand.hidden, false, 'offered');
      expand.click();
      await settle();
      await settle();
      assert.equal(dom.wrap.popoverOpen, true);
      assert.equal(dom.root.contains(dom.wrap), true, 'never leaves the panel');
      assert.deepEqual(expandLabel(dom), ['SHRINK', 'true']);
      // Esc shrinks the photo; the panel's own Esc (collapse) never sees it.
      let panelEsc = 0;
      dom.root.addEventListener('keydown', () => panelEsc++);
      expand.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await settle();
      await settle();
      assert.equal(dom.wrap.popoverOpen, false);
      assert.equal(panelEsc, 0, 'the panel stays open');
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
        'a closed popover would be hidden inside the panel',
      );
      assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
      controls.destroy();
    },
    { fullscreen: false, popover: true },
  ));

test('destroying the panel while the iPhone popover is open leaves no popover behind', () =>
  withDom(
    async (dom) => {
      const { controls } = await stubPanel(dom, uiState({ open: true }));
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
        const { controls } = await stubPanel(dom, uiState({ open: true }));
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

/* ── Restores and keyboard rules ───────────────────────────────────────── */

test('only an explicit switch-on opens the panel, unstored; a restore never does (P2-1)', () =>
  withDom(async (dom) => {
    const { layer, calls, controls, announce, subscribed } = await stubPanel(
      dom,
      uiState({ enabled: false }),
    );
    announce('restore');
    await layer.publish(uiState({ enabled: true }));
    assert.deepEqual(calls.collapsed, [], 'a restore leaves the panel be');
    await layer.publish(uiState({ enabled: false }));
    announce('user');
    await layer.publish(uiState({ enabled: true }));
    assert.deepEqual(calls.collapsed, [[false, { persist: false }]]);
    await layer.publish(uiState({ enabled: true, open: true }));
    assert.equal(calls.collapsed.length, 2, 'a photo opening opens it too');
    controls.destroy();
    assert.equal(subscribed(), false, 'destroy unsubscribes');
  }));

test('FIT / FILL show the selected render mode (P3)', () =>
  withDom(async (dom) => {
    const { layer, controls } = await stubPanel(dom, uiState({ open: true }));
    await layer.publish(uiState({ open: true, renderMode: 'fill' }));
    const [fit, fill] = dom.wrap.querySelectorAll('[data-sl-render]');
    assert.equal(fill.getAttribute('aria-checked'), 'true');
    assert.equal(fit.getAttribute('aria-checked'), 'false');
    assert.equal(fill.classList.contains('is-active'), true);
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
      const { layer, controls } = await stubPanel(dom, uiState({ open: true }));
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
    const { layer, controls } = await stubPanel(dom, uiState({ open: true }));
    await layer.publish(uiState({ open: true }));
    await settle();
    dom.writes();
    for (let i = 0; i < 10; i++) await layer.publish(uiState({ open: true }));
    await settle();
    assert.equal(dom.writes(), 0);
    controls.destroy();
  }));

test('arrow keys move the selection within a radiogroup, which has one tab stop (P3)', () =>
  withDom(async (dom) => {
    const { layer, calls, controls } = await stubPanel(dom, uiState());
    const keydown = (target, key) =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key }),
      );
    const [all, pano, flat] = dom.root.querySelectorAll('[data-sl-pano]');
    assert.deepEqual(
      [all, pano, flat].map((button) => button.getAttribute('tabindex')),
      ['0', '-1', '-1'],
    );
    all.focus();
    keydown(all, 'ArrowRight');
    assertSameNode(dom.document.activeElement, pano);
    assert.deepEqual(calls.setParams.at(-1), [
      { pano: 'pano' },
      { origin: 'user' },
    ]);
    keydown(all, 'ArrowLeft'); // wraps to the end
    assertSameNode(dom.document.activeElement, flat);
    keydown(flat, 'Home');
    assertSameNode(dom.document.activeElement, all);
    await layer.publish(uiState({ pano: 'flat' }));
    assert.deepEqual(
      [all, pano, flat].map((button) => button.getAttribute('tabindex')),
      ['-1', '-1', '0'],
    );
    controls.destroy();
  }));

test('under KEY REQUIRED the provider chip stays live and explains the key instead of toggling (P3)', () =>
  withDom(async (dom) => {
    const { calls, chip, controls } = await stubPanel(
      dom,
      uiState({ keyRequired: true }),
    );
    assert.equal(dom.root.querySelector('#sl-controls').disabled, true);
    assert.equal(
      dom.root.querySelector('#sl-controls').contains(chip()),
      false,
      'the chip is outside the disabled fieldset',
    );
    chip().click();
    await settle();
    assert.deepEqual(calls.setEnabled, []);
    assert.deepEqual(calls.setParams, []);
    assert.equal(calls.toasts.length, 1);
    assert.match(calls.toasts[0], /^Mapillary: Needs /);
    controls.destroy();
  }));

test('OPEN STREET VIEW opens the nearest panorama at the view centre without moving the camera', () =>
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
    const { layer } = await stubPanel(dom, state);
    const asked = [];
    layer.openNearest = (point, options) => asked.push([point, options]);
    const button = dom.root.querySelector('#sl-nearest-btn');
    assert.equal(button.hidden, false);
    assert.equal(button.textContent, 'OPEN STREET VIEW');
    button.click();
    assert.deepEqual(asked, [
      [
        undefined,
        { providerIds: ['google'], frame: false, aim: 'screen-centre' },
      ],
    ]);
    // Too high to mean a street: disabled, and a click does nothing.
    await layer.publish({ ...state, groundClickReady: false });
    assert.equal(button.disabled, true);
    button.click();
    assert.equal(asked.length, 1);
    // Off Google 3D the provider is not listed: no button.
    await layer.publish({ ...state, providers: [state.providers[0]] });
    assert.equal(button.hidden, true);
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
    const { calls, layer } = await stubPanel(dom, state);
    const chips = () => dom.root.querySelector('#sl-provider-chips').children;
    chips()[0].click(); // Mapillary: configured, dark
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
    chips()[1].click();
    await settle();
    assert.equal(calls.setParams.length, 1);
    assert.deepEqual(calls.toasts, [
      dom.root.querySelector('#sl-provider-chips').children[1].title,
    ]);
  }));

test('a swap names every registered provider, also those hidden on this map', () =>
  withDom(async (dom) => {
    const state = uiState({ on: false });
    const { calls, layer, chip } = await stubPanel(dom, state);
    // Off Google 3D the Street View chip is not listed, but stays registered.
    layer.providerIds = ['mapillary', 'google'];
    chip().click();
    await settle();
    assert.deepEqual(calls.setParams, [
      [{ mapillary: true, google: false }, { origin: 'user' }],
    ]);
  }));

test('a note under SINCE says what date it compares, only while one is given', () =>
  withDom(async (dom) => {
    const state = uiState();
    const { layer } = await stubPanel(dom, state);
    const note = () => dom.root.querySelector('#sl-since-note');
    assert.equal(note().hidden, true, 'none for Mapillary');
    await layer.publish({ ...state, sinceNote: '(by upload date)' });
    assert.equal(note().hidden, false);
    assert.equal(note().textContent, '(by upload date)');
    await layer.publish(state);
    assert.equal(note().hidden, true);
    // The panel's own markup has it, read out with the slider.
    const template = fs.readFileSync(
      new URL('./views/panels/StreetLevelPanel.vue', import.meta.url),
      'utf8',
    );
    assert.match(template, /<small id="sl-since-note"[^>]* :hidden="!view/);
    assert.match(template, /aria-describedby="sl-since-label sl-since-note"/);
  }));

test('Street View lit hides the imagery filters; Mapillary lit shows them', () =>
  withDom(async (dom) => {
    const state = uiState();
    const { layer } = await stubPanel(dom, state);
    const shown = () => ({
      pano: !dom.root.querySelector('#sl-pano-row').hidden,
      since: !dom.root.querySelector('#sl-since-row').hidden,
      controls: !dom.root.querySelector('#sl-controls').hidden,
    });
    assert.deepEqual(shown(), {
      pano: true,
      since: true,
      controls: true,
    });
    await layer.publish({
      ...state,
      filterControls: { pano: false, since: false },
    });
    assert.deepEqual(shown(), {
      pano: false,
      since: false,
      controls: false,
    });
    await layer.publish(state);
    assert.deepEqual(shown(), {
      pano: true,
      since: true,
      controls: true,
    });
  }));

test('dragging SINCE shows the stop under the thumb and leaves the thumb there', () =>
  withDom(async (dom) => {
    const { calls, controls } = await stubPanel(dom, uiState());
    const since = dom.root.querySelector('#sl-since');
    since.value = '5';
    since.dispatchEvent(new Event('input'));
    await settle();
    assert.equal(since.value, '5', 'the readout render keeps the thumb');
    assert.equal(
      dom.root.querySelector('#sl-since-label').textContent,
      'LAST YEAR',
    );
    since.dispatchEvent(new Event('change'));
    assert.deepEqual(calls.setParams.at(-1)[0], { sinceDays: 365 });
    controls.destroy();
  }));

test('a window changed elsewhere under a focused SINCE thumb leaves its readout alone', () =>
  withDom(async (dom) => {
    const state = uiState();
    const { layer, controls } = await stubPanel(dom, {
      ...state,
      filter: { ...state.filter, sinceDays: 365 },
    });
    const since = dom.root.querySelector('#sl-since');
    const label = () => dom.root.querySelector('#sl-since-label').textContent;
    assert.equal(since.value, '5');
    assert.match(label(), /^LAST YEAR · SINCE /);
    since.focus();
    await layer.publish({
      ...state,
      filter: { ...state.filter, sinceDays: 30 },
    });
    await settle();
    assert.equal(since.value, '5', 'the thumb stays under the hand');
    assert.match(label(), /^LAST YEAR · SINCE /, 'and the readout with it');
    assert.equal(since.getAttribute('aria-valuetext'), label());
    controls.destroy();
  }));
