import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { StreetLevelControls } from './streetLevelControls.js';
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
    const style = {};
    this.style = Object.assign(style, {
      setProperty: (key, value) => {
        style[key] = value;
      },
      removeProperty: (key) => {
        delete style[key];
      },
    });
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
  closest(selector) {
    for (let current = this; current; current = current.parent)
      if (current.matches?.(selector)) return current;
    return null;
  }
  insertBefore(child, before) {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    const at = before ? this.children.indexOf(before) : -1;
    if (at === -1) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }
  remove() {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
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
  add(root, 'div', { id: 'sl-provider-chips' });
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
  const fit = add(wrap, 'div', { classes: ['sl-seg'] });
  for (const mode of ['letterbox', 'fill'])
    add(fit, 'button', { dataset: { slRender: mode } });
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
  const panoRow = add(controls, 'div', { id: 'sl-pano-row' });
  for (const pano of ['all', 'pano', 'flat'])
    add(panoRow, 'button', { dataset: { slPano: pano } });
  const sinceRow = add(controls, 'div', { id: 'sl-since-row' });
  add(sinceRow, 'select', { id: 'sl-since' });
  add(sinceRow, 'small', { id: 'sl-since-note' });
  const metaRow = add(root, 'div', { classes: ['sl-meta-row'] });
  add(metaRow, 'div', { id: 'sl-coverage-meta' });
  add(metaRow, 'button', { id: 'sl-nearest-btn' });
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
    actions: {
      isEnabled: () => manager.isEnabled('street-level'),
      setEnabled: (on) =>
        manager.setEnabled('street-level', on, { origin: 'user' }),
      setParams: (params, options) =>
        manager.setLayerParams('street-level', params, options),
      setPanelCollapsed() {},
      showToast() {},
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

test('choosing a SINCE window records it in the share link', () =>
  withDom(async (dom) => {
    const { coordinator, controls, share } = await productionPanel(dom);
    const since = dom.root.querySelector('#sl-since');
    since.value = '365'; // the "last year" stop
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
  sinceDays = 0,
  renderMode = 'letterbox',
  keyRequired = false,
  streetError = null,
  sequenceError = null,
} = {}) {
  return {
    enabled,
    providers: [providerSnapshot({ on, keyRequired })],
    keyRequired,
    keyRejected: false,
    filter: { pano, sinceDays },
    coverage: { count: 3, loading: false, hint: '', error: null },
    sequence: {
      selectedId: null,
      images: 0,
      loading: false,
      error: sequenceError,
    },
    street: {
      open,
      loading: false,
      renderMode,
      imageId: open ? 'img-1' : null,
      error: streetError,
    },
  };
}

function stubPanel(dom, state, extraActions = {}) {
  const layer = stubLayer();
  const calls = { setParams: [], setEnabled: [], collapsed: [], toasts: [] };
  let enabled = state.enabled;
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
      showToast: (message) => calls.toasts.push(message),
      ...extraActions,
    },
  });
  controls.connect();
  return {
    layer,
    calls,
    controls,
    chip: () => dom.root.querySelector('#sl-provider-chips').children[0],
  };
}

test('the header pill switches the layer; provider switches are left alone', () =>
  withDom(async (dom) => {
    const status = dom.root.querySelector('#sl-status');
    const { calls, controls } = stubPanel(dom, uiState());
    status.click();
    await settle();
    assert.deepEqual(calls.setEnabled, [false]);
    assert.deepEqual(calls.setParams, []);
    controls.destroy();
  }));

test('darkening the only lit chip turns the layer off and keeps the provider switched on', () =>
  withDom(async (dom) => {
    const { calls, chip, controls } = stubPanel(dom, uiState());
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
    const { calls, chip, controls } = stubPanel(
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
    const { calls, chip, controls } = stubPanel(
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
    const { controls } = stubPanel(dom, uiState({ keyRequired: true }));
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

test('shrinkViewer takes the photo out of full screen (Clean View, recording, the cockpit)', () =>
  withDom(async (dom) => {
    const { controls } = stubPanel(dom, uiState({ open: true }));
    dom.root.querySelector('#sl-viewer-expand').click();
    await settle();
    await settle();
    assert.equal(dom.document.fullscreenElement, dom.wrap);
    controls.shrinkViewer();
    await settle();
    await settle();
    assert.equal(dom.document.fullscreenElement, null);
    controls.shrinkViewer(); // nothing expanded: nothing to do
    controls.destroy();
  }));

test('the shell shrinks the photo when Clean View, recording or the cockpit hide the panels', () => {
  const shell = fs.readFileSync(
    new URL('./applicationShell.js', import.meta.url),
    'utf8',
  );
  const facade = fs.readFileSync(
    new URL('./shellFacade.js', import.meta.url),
    'utf8',
  );
  assert.match(
    shell,
    /toggleCleanView[\s\S]*?if \(shouldEnable\) this\._streetLevelControls\?\.shrinkViewer\(\)/,
  );
  assert.match(
    shell,
    /enterPanels: \(\) => \{[\s\S]*?this\._streetLevelControls\?\.shrinkViewer\(\);/,
  );
  assert.match(
    facade,
    /setRecordingMode\(enabled, options\) \{[\s\S]*?this\._streetLevelControls\?\.shrinkViewer\(\);/,
  );
});

/* ── Restores and keyboard rules ───────────────────────────────────────── */

test('a photo opening opens the panel, unstored; switching the layer on does not', () =>
  withDom(async (dom) => {
    const { layer, calls, controls } = stubPanel(
      dom,
      uiState({ enabled: false }),
    );
    layer.publish(uiState({ enabled: true }));
    assert.deepEqual(calls.collapsed, [], 'a switch-on leaves the panel be');
    layer.publish(uiState({ enabled: true, open: true }));
    assert.deepEqual(calls.collapsed, [[false, { persist: false }]]);
    controls.destroy();
  }));

test('a photo that fails to open opens the panel too, so its error shows', () =>
  withDom(async (dom) => {
    const { layer, calls, controls } = stubPanel(dom, uiState());
    // A line click whose lookup KartaView never answered.
    layer.publish(uiState({ streetError: 'KartaView did not answer in time' }));
    assert.deepEqual(calls.collapsed, [[false, { persist: false }]]);
    // The same error again opens nothing more; a new one does.
    layer.publish(uiState({ streetError: 'KartaView did not answer in time' }));
    assert.equal(calls.collapsed.length, 1);
    layer.publish(uiState());
    layer.publish(uiState({ streetError: 'No street-level imagery here' }));
    assert.equal(calls.collapsed.length, 2);
    controls.destroy();
  }));

test('a sequence that fails to load opens the panel, so its error shows', () =>
  withDom(async (dom) => {
    const { layer, calls, controls } = stubPanel(dom, uiState());
    // A Mapillary line click whose sequence lookup the Graph API refused.
    layer.publish(uiState({ sequenceError: 'Mapillary did not answer' }));
    assert.deepEqual(calls.collapsed, [[false, { persist: false }]]);
    assert.equal(dom.root.querySelector('#sl-error').hidden, false);
    layer.publish(uiState({ sequenceError: 'Mapillary did not answer' }));
    assert.equal(calls.collapsed.length, 1, 'the same error opens it once');
    controls.destroy();
  }));

test('FIT / FILL show the selected render mode (P3)', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    layer.publish(uiState({ open: true, renderMode: 'fill' }));
    const [fit, fill] = dom.wrap.querySelectorAll('[data-sl-render]');
    assert.equal(fill.getAttribute('aria-pressed'), 'true');
    assert.equal(fit.getAttribute('aria-pressed'), 'false');
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

test('the imagery filter is a row of toggle buttons, the chosen one pressed', () =>
  withDom(async (dom) => {
    const { layer, calls, controls } = stubPanel(dom, uiState());
    const [all, pano, flat] = dom.root.querySelectorAll('[data-sl-pano]');
    const pressed = () =>
      [all, pano, flat].map((button) => button.getAttribute('aria-pressed'));
    assert.deepEqual(pressed(), ['true', 'false', 'false']);
    pano.click();
    assert.deepEqual(calls.setParams.at(-1), [
      { pano: 'pano' },
      { origin: 'user' },
    ]);
    layer.publish(uiState({ pano: 'flat' }));
    assert.deepEqual(pressed(), ['false', 'false', 'true']);
    // No roving tab stop: every button is reachable with Tab.
    assert.deepEqual(
      [all, pano, flat].map((button) => button.getAttribute('tabindex')),
      [null, null, null],
    );
    controls.destroy();
  }));

test('SINCE lists the stops, adds a link’s own day count and names the cut-off date', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState());
    const since = dom.root.querySelector('#sl-since');
    assert.equal(since.children.length, 9, 'the nine stops');
    assert.equal(since.children[0].textContent, 'ANY DATE');
    layer.publish(uiState({ sinceDays: 365 }));
    assert.equal(since.value, '365');
    assert.match(since.title, /^LAST YEAR · SINCE \d{4}-\d{2}-\d{2}$/);
    layer.publish(uiState({ sinceDays: 400 }));
    assert.equal(since.children.length, 10);
    assert.equal(since.children[9].textContent, 'LAST 400 DAYS');
    assert.equal(since.value, '400');
    layer.publish(uiState({ sinceDays: 30 }));
    assert.equal(since.children.length, 9, 'gone once a stop is chosen');
    controls.destroy();
  }));

test('under KEY REQUIRED the provider chip stays live and explains the key instead of toggling (P3)', () =>
  withDom(async (dom) => {
    const { calls, chip, controls } = stubPanel(
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
    const { layer } = stubPanel(dom, state);
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
    layer.publish({ ...state, groundClickReady: false });
    assert.equal(button.disabled, true);
    button.click();
    assert.equal(asked.length, 1);
    // Off Google 3D the provider is not listed: no button.
    layer.publish({ ...state, providers: [state.providers[0]] });
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
    const { calls, layer } = stubPanel(dom, state);
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
    layer.publish({ ...state });
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
    const { calls, layer, chip } = stubPanel(dom, state);
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
    const { layer } = stubPanel(dom, state);
    const note = () => dom.root.querySelector('#sl-since-note');
    assert.equal(note().hidden, true, 'none for Mapillary');
    layer.publish({ ...state, sinceNote: 'KartaView: by upload date' });
    assert.equal(note().hidden, false);
    assert.equal(note().textContent, 'KartaView: by upload date');
    layer.publish(state);
    assert.equal(note().hidden, true);
    // The panel's own markup has it, read out with the slider.
    const template = fs.readFileSync(
      new URL('./templates/layer-panels.html', import.meta.url),
      'utf8',
    );
    assert.match(template, /<small id="sl-since-note"[^>]* hidden>/);
    assert.match(
      template,
      /<select id="sl-since"[^>]*aria-describedby="sl-since-note"/,
    );
  }));

test('Street View lit hides the imagery filters; Mapillary lit shows them', () =>
  withDom(async (dom) => {
    const state = uiState();
    const { layer } = stubPanel(dom, state);
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
    layer.publish({
      ...state,
      filterControls: { pano: false, since: false },
    });
    assert.deepEqual(shown(), {
      pano: false,
      since: false,
      controls: false,
    });
    layer.publish(state);
    assert.deepEqual(shown(), {
      pano: true,
      since: true,
      controls: true,
    });
  }));
