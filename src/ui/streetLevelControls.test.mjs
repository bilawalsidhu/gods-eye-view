import assert from 'node:assert/strict';
import test from 'node:test';
import { StreetLevelControls } from './streetLevelControls.js';
import { createStreetLevelLayer } from '../layers/streetLevel/index.js';
import { DataLayerManager } from '../data/manager.js';
import { LayerStateCoordinator } from '../data/layerStateCoordinator.js';
import {
  LAYER_STATE_REGISTRY,
  REGISTERED_LAYER_IDS,
  encodeLayerStateParams,
} from '../data/layerState.js';
import { fakeMapillarySource } from '../testSupport/streetLevelFakes.mjs';

/* ── A small DOM: just what the panel controls touch ───────────────────── */

/** Every write a page would see as a mutation, even one to the same value. */
const mutations = { count: 0 };
const REFLECTED = ['hidden', 'disabled', 'textContent', 'title', 'value'];

class FakeNode {
  constructor(document, tag, { id = null, dataset = {}, classes = [] } = {}) {
    this.listeners = new Map();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.dataset = { ...dataset };
    this.children = [];
    this.parent = null;
    this.props = {
      hidden: false,
      disabled: false,
      textContent: '',
      title: '',
      value: '',
    };
    for (const key of REFLECTED)
      Object.defineProperty(this, key, {
        get: () => this.props[key],
        set: (value) => {
          mutations.count++;
          this.props[key] = value;
        },
      });
    this.attributes = new Map();
    const names = new Set(classes);
    this.classList = {
      contains: (name) => names.has(name),
      toggle: (name, force) => {
        const on = force ?? !names.has(name);
        if (on) names.add(name);
        else names.delete(name);
        return on;
      },
    };
    this.style = {};
    Object.defineProperty(this, 'className', {
      get: () => [...names].join(' '),
      set: (value) => {
        mutations.count++;
        names.clear();
        for (const name of String(value).split(/\s+/).filter(Boolean))
          names.add(name);
      },
    });
  }
  get childElementCount() {
    return this.children.length;
  }
  setAttribute(key, value) {
    mutations.count++;
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key) {
    mutations.count++;
    this.attributes.delete(key);
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  contains(node) {
    for (let current = node; current; current = current.parent)
      if (current === this) return true;
    return false;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  /** `#id`, `.class` or `[data-x]`. */
  matches(selector) {
    const byId = /^#(.+)$/.exec(selector);
    if (byId) return this.id === byId[1];
    const byClass = /^\.(.+)$/.exec(selector);
    if (byClass) return this.classList.contains(byClass[1]);
    const byData = /^\[data-([a-z-]+)\]$/.exec(selector);
    return Boolean(
      byData &&
      byData[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in this.dataset,
    );
  }
  querySelectorAll(selector) {
    return [...this.walk()].filter((node) => node.matches(selector));
  }
  addEventListener(type, listener, { signal } = {}) {
    if (signal?.aborted) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    signal?.addEventListener('abort', () =>
      this.listeners.get(type)?.delete(listener),
    );
  }
  /** Deliver to this node, then bubble up with the same target. */
  dispatchEvent(event) {
    const delivered = {
      type: event.type,
      target: this,
      key: event.key,
      newState: event.newState,
      stopped: false,
      preventDefault() {},
      stopPropagation() {
        this.stopped = true;
      },
    };
    for (
      let node = this;
      node && !delivered.stopped;
      node = event.bubbles ? node.parent : null
    )
      for (const listener of [...(node.listeners.get(event.type) || [])])
        listener(delivered);
    return true;
  }
  click() {
    this.dispatchEvent({ type: 'click', bubbles: true });
  }
}

/**
 * The Street Level panel's body, as layer-panels.html lays it out, on a page
 * with the Fullscreen API unless `fullscreen` is false, and the Popover API
 * if `popover` is true (iPhone Safari: popovers, no element fullscreen).
 */
function panelDom({ fullscreen = true, popover = false } = {}) {
  const document = new FakeNode(null, '#document');
  Object.assign(document, {
    ownerDocument: document,
    activeElement: null,
    fullscreenElement: null,
    createElement: (tag) => new FakeNode(document, tag),
  });
  // The browser reports a change after the request settles.
  const fullscreenTo = (element) => {
    document.fullscreenElement = element;
    setTimeout(() => document.dispatchEvent({ type: 'fullscreenchange' }), 0);
  };
  document.exitFullscreen = async () => fullscreenTo(null);
  document.body = document.appendChild(new FakeNode(document, 'body'));
  const root = document.body.appendChild(
    new FakeNode(document, 'section', { id: 'street-level-panel' }),
  );
  const add = (parent, tag, options) =>
    parent.appendChild(new FakeNode(document, tag, options));
  add(root, 'button', { id: 'sl-status' });
  const wrap = add(root, 'div', { id: 'sl-viewer-wrap' });
  if (fullscreen) wrap.requestFullscreen = async () => fullscreenTo(wrap);
  if (popover) {
    // `popover` reflects its attribute, as in the DOM.
    Object.defineProperty(wrap, 'popover', {
      get: () => wrap.getAttribute('popover'),
      set: (value) => wrap.setAttribute('popover', value),
    });
    // The browser fires `toggle` after the popover opens or closes.
    const toggleTo = (newState) =>
      setTimeout(() => wrap.dispatchEvent({ type: 'toggle', newState }), 0);
    wrap.showPopover = () => {
      wrap.popoverOpen = true;
      toggleTo('open');
    };
    wrap.hidePopover = () => {
      wrap.popoverOpen = false;
      toggleTo('closed');
    };
  }
  const expand = add(wrap, 'button', { id: 'sl-viewer-expand' });
  add(expand, 'span', { classes: ['sl-btn-icon'] });
  add(expand, 'span', { classes: ['sl-btn-text'] });
  for (const mode of ['letterbox', 'fill'])
    add(wrap, 'button', { dataset: { slRender: mode } });
  add(wrap, 'button', { id: 'sl-viewer-close' });
  for (const id of [
    'sl-viewer-placeholder',
    'sl-viewer',
    'sl-image-by',
    'sl-image-when',
    'sl-image-link',
  ])
    add(wrap, id === 'sl-image-link' ? 'a' : 'div', { id });
  const error = add(root, 'div', { id: 'sl-error' });
  add(error, 'span', { id: 'sl-error-text' });
  const controls = add(root, 'fieldset', { id: 'sl-controls' });
  for (const pano of ['all', 'pano', 'flat'])
    add(controls, 'button', { dataset: { slPano: pano } });
  add(controls, 'input', { id: 'sl-since' });
  add(controls, 'output', { id: 'sl-since-label' });
  add(root, 'ul', { id: 'sl-legend' });
  add(root, 'div', { id: 'sl-coverage-meta' });
  return { document, root, wrap };
}

/** Run `fn` with the fake document and an immediate animation frame. */
async function withDom(fn, options) {
  const saved = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const page = panelDom(options);
  globalThis.document = page.document;
  globalThis.requestAnimationFrame = (task) => setTimeout(task, 0);
  try {
    return await fn(page);
  } finally {
    globalThis.document = saved.document;
    globalThis.requestAnimationFrame = saved.requestAnimationFrame;
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
  const layer = createStreetLevelLayer({ source: fakeMapillarySource() });
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
    publish(next) {
      state = next;
      for (const listener of listeners) listener(state);
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
    providerOn: on,
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

function stubPanel(dom, state, extraActions = {}) {
  const layer = stubLayer();
  const calls = { setParams: [], setEnabled: [], collapsed: [] };
  let enabled = state.enabled;
  /** Reports a switch-on request's origin, as the data manager does. */
  let announce = null;
  layer.publish(state);
  const controls = new StreetLevelControls({
    root: dom.root,
    layer,
    actions: {
      isEnabled: () => enabled,
      setEnabled: async (on) => {
        calls.setEnabled.push(on);
        enabled = on;
      },
      setParams: (params, options) => calls.setParams.push([params, options]),
      setPanelCollapsed: (collapsed, options) =>
        calls.collapsed.push([collapsed, options]),
      showToast() {},
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
  return {
    layer,
    calls,
    controls,
    announce: (origin) => announce?.(origin),
    subscribed: () => announce !== null,
  };
}

test('the header pill switches the layer, bringing back Mapillary switched off elsewhere', () =>
  withDom(async (dom) => {
    const status = dom.root.querySelector('#sl-status');
    const on = stubPanel(dom, uiState());
    status.click();
    await settle();
    assert.deepEqual(on.calls.setEnabled, [false]);
    assert.deepEqual(on.calls.setParams, [], 'switching off keeps the switch');
    on.controls.destroy();
    const dark = stubPanel(dom, uiState({ enabled: false, on: false }));
    status.click();
    await settle();
    assert.deepEqual(dark.calls.setParams, [
      [{ mapillary: true }, { origin: 'user' }],
    ]);
    assert.deepEqual(dark.calls.setEnabled, [true]);
    dark.controls.destroy();
  }));

test('a layer that is on with Mapillary switched off reads OFF, and the pill brings Mapillary back', () =>
  withDom(async (dom) => {
    const status = dom.root.querySelector('#sl-status');
    const { calls, controls } = stubPanel(dom, uiState({ on: false }));
    assert.equal(status.textContent, 'OFF');
    assert.equal(status.getAttribute('aria-pressed'), 'false');
    assert.match(
      dom.root.querySelector('#sl-coverage-meta').textContent,
      /Mapillary is off in this view/,
    );
    assert.equal(
      dom.root.querySelector('#sl-legend').hidden,
      true,
      'no legend',
    );
    status.click();
    await settle();
    assert.deepEqual(calls.setParams, [
      [{ mapillary: true }, { origin: 'user' }],
    ]);
    assert.deepEqual(calls.setEnabled, [], 'the layer itself stays on');
    controls.destroy();
  }));

test('under KEY REQUIRED the filters are gated and the error line says how to add the key', () =>
  withDom(async (dom) => {
    const { controls } = stubPanel(dom, uiState({ keyRequired: true }));
    assert.equal(dom.root.querySelector('#sl-controls').disabled, true);
    assert.equal(dom.root.querySelector('#sl-error').hidden, false);
    assert.match(
      dom.root.querySelector('#sl-error-text').textContent,
      /^Mapillary: Needs MAPILLARY_CLIENT_TOKEN/,
    );
    controls.destroy();
  }));

test('the viewer is resized once when it opens, not on every render', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState());
    await settle();
    assert.equal(layer.calls.resize, 0);
    layer.publish(uiState({ open: true }));
    await settle();
    // Opening also opens the panel; the two share one coalesced resize.
    assert.equal(layer.calls.resize, 1, 'once on open');
    for (let i = 0; i < 5; i++) layer.publish(uiState({ open: true }));
    await settle();
    assert.equal(layer.calls.resize, 1, 'not again while it stays open');
    layer.publish(uiState({ open: false }));
    layer.publish(uiState({ open: true }));
    await settle();
    assert.equal(layer.calls.resize, 2, 'the next photo resizes again');
    controls.destroy();
  }));

test('closing the image from its × button leaves focus on the panel, not <body>', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    dom.root.querySelector('#sl-viewer-close').focus();
    layer.publish(uiState({ open: false }));
    assert.equal(dom.wrap.hidden, true);
    assert.equal(
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
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    await settle();
    const resizes = layer.calls.resize;
    const expand = dom.root.querySelector('#sl-viewer-expand');
    expand.click();
    await settle();
    await settle();
    assert.equal(dom.document.fullscreenElement, dom.wrap);
    assert.equal(dom.root.contains(dom.wrap), true, 'never leaves the panel');
    assert.deepEqual(expandLabel(dom), ['SHRINK', 'true']);
    assert.equal(layer.calls.resize, resizes + 1, 'the viewer refits');
    expand.click();
    await settle();
    await settle();
    assert.equal(dom.document.fullscreenElement, null);
    assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
    controls.destroy();
  }));

test('Esc in full screen shrinks the photo; the panel never sees it', () =>
  withDom(async (dom) => {
    const { controls } = stubPanel(dom, uiState({ open: true }));
    const expand = dom.root.querySelector('#sl-viewer-expand');
    expand.click();
    await settle();
    await settle();
    assert.equal(dom.document.fullscreenElement, dom.wrap);
    let panelEsc = 0;
    dom.root.addEventListener('keydown', () => panelEsc++);
    expand.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    await settle();
    await settle();
    assert.equal(dom.document.fullscreenElement, null);
    assert.equal(panelEsc, 0, 'the panel stays open');
    assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
    // Not expanded, Esc is the panel's again.
    expand.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    assert.equal(panelEsc, 1);
    controls.destroy();
  }));

test('an image closed while full screen leaves full screen', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    dom.root.querySelector('#sl-viewer-expand').click();
    await settle();
    layer.publish(uiState({ open: false }));
    await settle();
    assert.equal(dom.document.fullscreenElement, null);
    assert.equal(dom.wrap.hidden, true);
    assert.deepEqual(expandLabel(dom), ['EXPAND', 'false']);
    controls.destroy();
  }));

test('without the Fullscreen or Popover API there is no EXPAND button', () =>
  withDom(
    async (dom) => {
      const { controls } = stubPanel(dom, uiState({ open: true }));
      assert.equal(dom.root.querySelector('#sl-viewer-expand').hidden, true);
      controls.destroy();
    },
    { fullscreen: false },
  ));

test('on iPhone (no element fullscreen) EXPAND opens the viewer as a popover over the page', () =>
  withDom(
    async (dom) => {
      const { controls } = stubPanel(dom, uiState({ open: true }));
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
      expand.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
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
      const { controls } = stubPanel(dom, uiState({ open: true }));
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
        const { controls } = stubPanel(dom, uiState({ open: true }));
        dom.root.querySelector('#sl-viewer-expand').click();
        await settle();
        await settle();
        assert.equal(dom.document.fullscreenElement, dom.wrap);
        assert.equal(watch.observers.size, 1, 'watching while expanded');
        dom.document.body.classList.toggle(mode, true);
        watch.fire();
        await settle();
        await settle();
        assert.equal(dom.document.fullscreenElement, null);
        assert.equal(watch.observers.size, 0, 'and not after');
        controls.destroy();
      } finally {
        globalThis.MutationObserver = saved;
      }
    }));

/* ── Restores and keyboard rules ───────────────────────────────────────── */

test('only an explicit switch-on opens the panel, unstored; a restore never does (P2-1)', () =>
  withDom(async (dom) => {
    const { layer, calls, controls, announce, subscribed } = stubPanel(
      dom,
      uiState({ enabled: false }),
    );
    announce('restore');
    layer.publish(uiState({ enabled: true }));
    assert.deepEqual(calls.collapsed, [], 'a restore leaves the panel be');
    layer.publish(uiState({ enabled: false }));
    announce('user');
    layer.publish(uiState({ enabled: true }));
    assert.deepEqual(calls.collapsed, [[false, { persist: false }]]);
    layer.publish(uiState({ enabled: true, open: true }));
    assert.equal(calls.collapsed.length, 2, 'a photo opening opens it too');
    controls.destroy();
    assert.equal(subscribed(), false, 'destroy unsubscribes');
  }));

test('FIT / FILL show the selected render mode (P3)', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    layer.publish(uiState({ open: true, renderMode: 'fill' }));
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
      const { layer, controls } = stubPanel(dom, uiState({ open: true }));
      await settle();
      const resizes = layer.calls.resize;
      const viewer = dom.root.querySelector('#sl-viewer');
      Object.assign(viewer, { clientWidth: 0, clientHeight: 0 });
      observers[0]();
      await settle();
      assert.equal(layer.calls.resize, resizes, 'skipped while 0×0');
      Object.assign(viewer, { clientWidth: 640, clientHeight: 400 });
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
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    layer.publish(uiState({ open: true }));
    const before = mutations.count;
    for (let i = 0; i < 10; i++) layer.publish(uiState({ open: true }));
    assert.equal(mutations.count - before, 0);
    controls.destroy();
  }));

test('arrow keys move the selection within a radiogroup, which has one tab stop (P3)', () =>
  withDom(async (dom) => {
    const { layer, calls, controls } = stubPanel(dom, uiState());
    const keydown = (target, key) =>
      target.dispatchEvent({ type: 'keydown', bubbles: true, key });
    const [all, pano, flat] = dom.root.querySelectorAll('[data-sl-pano]');
    assert.deepEqual(
      [all, pano, flat].map((button) => button.getAttribute('tabindex')),
      ['0', '-1', '-1'],
    );
    all.focus();
    keydown(all, 'ArrowRight');
    assert.equal(dom.document.activeElement, pano);
    assert.deepEqual(calls.setParams.at(-1), [
      { pano: 'pano' },
      { origin: 'user' },
    ]);
    keydown(all, 'ArrowLeft'); // wraps to the end
    assert.equal(dom.document.activeElement, flat);
    keydown(flat, 'Home');
    assert.equal(dom.document.activeElement, all);
    layer.publish(uiState({ pano: 'flat' }));
    assert.deepEqual(
      [all, pano, flat].map((button) => button.getAttribute('tabindex')),
      ['-1', '-1', '0'],
    );
    controls.destroy();
  }));
