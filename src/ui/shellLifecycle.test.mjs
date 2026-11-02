import test from 'node:test';
import assert from 'node:assert/strict';
import { UiLifetime } from './uiLifetime.js';
import { createPinia } from 'pinia';
import { PanelChrome } from './panelChrome.js';
import { followPanelState } from './rail/panelState.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { PanelLayoutController } from './panelLayoutController.js';
import { ShellFeedback } from './shellFeedback.js';
import { RecordingControls } from './recordingControls.js';

function fixture() {
  const saved = Object.fromEntries(
    [
      'document',
      'window',
      'localStorage',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ].map((key) => [key, globalThis[key]]),
  );
  const frames = new Map(),
    timers = new Map();
  let next = 0;
  const element = () => {
    const classes = new Set();
    return Object.assign(new EventTarget(), {
      style: {},
      dataset: {},
      hidden: false,
      textContent: '',
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, active) =>
          active ? classes.add(name) : classes.delete(name),
      },
      matches: () => false,
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      contains: () => false,
      getBoundingClientRect: () => ({
        left: 20,
        top: 30,
        width: 100,
        height: 80,
      }),
    });
  };
  const nodes = new Map(
    [
      'left-panel-stack',
      'right-context-rail',
      'pp-toggles',
      'hud-toggle',
      'hud-layout-select',
    ].map((id) => [id, element()]),
  );
  globalThis.document = Object.assign(new EventTarget(), {
    hidden: false,
    getElementById: (id) => nodes.get(id) || null,
    querySelectorAll: () => [],
    body: element(),
  });
  globalThis.window = Object.assign(new EventTarget(), {
    innerWidth: 600,
    innerHeight: 400,
  });
  const writes = [];
  globalThis.localStorage = {
    setItem: (...args) => writes.push(args),
    getItem: () => null,
  };
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++next, callback);
    return next;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.setTimeout = globalThis.setInterval = (callback) => {
    timers.set(++next, callback);
    return next;
  };
  globalThis.clearTimeout = globalThis.clearInterval = (id) =>
    timers.delete(id);
  return {
    frames,
    timers,
    nodes,
    element,
    writes,
    restore() {
      Object.assign(globalThis, saved);
    },
  };
}

test('UI lifetime revokes listeners and nested presentation work synchronously', () => {
  const f = fixture();
  try {
    const owner = new UiLifetime(),
      target = new EventTarget();
    let calls = 0;
    owner.listen(target, 'change', () => calls++);
    owner.frame(() => {
      calls++;
      owner.frame(() => calls++);
    });
    owner.timeout(() => calls++, 100);
    const retainedFrame = [...f.frames.values()][0];
    owner.destroy();
    owner.destroy();
    target.dispatchEvent(new Event('change'));
    retainedFrame();
    owner.frame(() => calls++);
    owner.timeout(() => calls++, 1);
    assert.equal(calls, 0);
    assert.equal(f.frames.size + f.timers.size + owner.removers.size, 0);
  } finally {
    f.restore();
  }
});

test('one-time UI listeners and cancelled notice timers release their registrations', () => {
  const f = fixture();
  try {
    const owner = new UiLifetime(),
      target = new EventTarget();
    let calls = 0;
    owner.listen(target, 'change', () => calls++, { once: true });
    target.dispatchEvent(new Event('change'));
    target.dispatchEvent(new Event('change'));
    owner.cancelTimeout(owner.timeout(() => calls++, 100));
    assert.equal(calls, 1);
    assert.equal(owner.removers.size + owner.timers.size + f.timers.size, 0);
    owner.destroy();
  } finally {
    f.restore();
  }
});

test('panel layout coalesces each rail and cannot rearm after destruction', () => {
  const f = fixture();
  try {
    let layouts = 0;
    const owner = new PanelLayoutController({
      readHud: () => ({}),
      scheduleCockpitLayout() {},
      presentPanel() {},
      readDisplayScrollTop: () => 0,
    });
    owner._syncLeftPanelAdaptiveLayout = () => layouts++;
    owner._scheduleLeftPanelLayout();
    owner._scheduleLeftPanelLayout();
    assert.equal(f.frames.size, 1);
    owner._scheduleAdaptivePanelLayout({ settle: true });
    assert.equal(f.frames.size, 2);
    assert.equal(f.timers.size, 1);
    const late = [...f.frames.values(), ...f.timers.values()];
    owner.destroy();
    owner.destroy();
    late.forEach((callback) => callback());
    owner._scheduleAdaptivePanelLayout({ settle: true });
    assert.equal(layouts, 0);
    assert.equal(f.frames.size + f.timers.size, 0);
  } finally {
    f.restore();
  }
});

test('feedback disposal clears toast and polling work and rejects retained notices', () => {
  const f = fixture();
  try {
    const loading = [];
    const toasts = [];
    const owner = new ShellFeedback({
      readLayers: () => [],
      store: {
        toast: null,
        publishToast(view) {
          this.toast = view;
          toasts.push(view);
        },
        publishLoading: (view) => loading.push(view),
        publishTraffic() {},
      },
    });
    owner.observeVisibility();
    owner._startTrafficChipTicker();
    owner._showToast('Saved');
    assert.equal(f.timers.size, 2);
    owner._showGlobalStatusNotice('Saving');
    assert.equal(loading.at(-1).hidden, false);
    owner.destroy();
    owner._showToast('Late');
    owner._showGlobalStatusNotice('Late');
    owner._startTrafficChipTicker();
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(f.timers.size, 0);
    assert.deepEqual(
      toasts.map(({ text, visible }) => ({ text, visible })),
      [
        { text: 'Saved', visible: true },
        { text: 'Saved', visible: false },
      ],
    );
    assert.equal(loading.at(-1).hidden, true);
    assert.equal(loading.at(-1).label, 'Saving', 'the hidden label stays');
  } finally {
    f.restore();
  }
});

test('recording restores the original HUD after repeated entry and revokes retained controls', () => {
  const f = fixture();
  try {
    let mode = 'auto',
      variant = 'tactical';
    const hudSyncs = [];
    const frames = [];
    const owner = new RecordingControls({
      syncShareState() {},
      syncHudControls: () => hudSyncs.push(variant),
      publishSafeFrame: (frame) => frames.push(frame),
    });
    owner.hud = {
      getMode: () => mode,
      getVariant: () => variant,
      setMode: (value) => {
        mode = value;
      },
      setVariant: (value) => {
        variant = value;
      },
      visible: true,
    };
    owner.setRecordingMode(true, { hudMode: 'minimal', safeFrame: '9:16' });
    owner.setRecordingMode(true, { hudMode: 'off' });
    owner.destroy();
    owner.setRecordingMode(true);
    assert.equal(mode, 'auto');
    assert.equal(variant, 'tactical');
    assert.deepEqual(
      hudSyncs,
      ['minimal', 'minimal', 'tactical'],
      'each change shows the HUD layout it leaves',
    );
    assert.equal(document.body.classList.contains('recording-mode'), false);
    assert.deepEqual(
      frames,
      ['9:16', '16:9', null],
      'the safe frame follows each change and leaves with the recording',
    );
  } finally {
    f.restore();
  }
});

test('weather rail orders between CCTV and Context, observes and presents chrome', (t) => {
  const f = fixture();
  const observed = new Set();
  const previousResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe(node) {
      observed.add(node);
    }
    disconnect() {
      observed.clear();
    }
  };
  t.after(() => {
    if (previousResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previousResizeObserver;
  });
  try {
    const stack = f.nodes.get('right-context-rail');
    stack.children = [];
    stack.insertBefore = (panel, before) => {
      stack.children = stack.children.filter((child) => child !== panel);
      const index = before
        ? stack.children.indexOf(before)
        : stack.children.length;
      stack.children.splice(index, 0, panel);
    };
    stack.prepend = (panel) => stack.insertBefore(panel, stack.children[0]);
    for (const id of [
      'pp-toggles',
      'cctv-panel',
      'weather-panel',
      'global-context-panel',
    ]) {
      const panel = f.nodes.get(id) || f.element();
      panel.id = id;
      panel.style = {};
      panel.classList.add('collapsed');
      f.nodes.set(id, panel);
    }
    const weather = f.nodes.get('weather-panel');
    stack.children = [weather, f.nodes.get('global-context-panel')];
    const store = usePanelChromeStore(createPinia());
    const chrome = {
      _chromeStore: store,
      _chromeToken: store.connect({}),
      _shownPanel: PanelChrome.prototype._shownPanel,
    };
    const presented = [];
    const owner = new PanelLayoutController({
      readHud: () => ({}),
      scheduleCockpitLayout() {},
      readDisplayScrollTop: () => 0,
      presentPanel(panel, patch) {
        presented.push(panel.id);
        PanelChrome.prototype._presentPanel.call(chrome, panel, patch);
      },
    });
    owner._initRightPanelAdaptiveLayout();
    assert.deepEqual(
      stack.children.map((panel) => panel.id),
      ['pp-toggles', 'cctv-panel', 'weather-panel', 'global-context-panel'],
    );
    assert.ok(observed.has(weather));
    // Moving a panel into the rail leaves its state as it was.
    assert.deepEqual(presented, []);
    followPanelState(store, 'weather-panel', weather);
    PanelChrome.prototype._presentPanel.call(chrome, weather, {
      collapsed: false,
    });
    assert.equal(store.panels['weather-panel'].collapsed, false);
    assert.equal(weather.classList.contains('collapsed'), false);
    owner.destroy();
    assert.equal(observed.size, 0);
    assert.equal(f.frames.size, 0);
  } finally {
    f.restore();
  }
});

test('busy traffic completion is polled promptly without accelerating idle or global reads', (t) => {
  const f = fixture();
  let now = 500;
  t.mock.method(performance, 'now', () => now);
  try {
    const owner = new ShellFeedback({ readLayers: () => [] });
    let traffic = 0,
      global = 0;
    owner._updateTrafficSyncChip = () => traffic++;
    owner._updateGlobalLoadingFeedback = () => global++;
    owner._startTrafficChipTicker();
    const tick = f.timers.get(owner._trafficChipTicker);
    tick();
    assert.equal(traffic, 1);
    assert.equal(global, 1);
    now = 600;
    tick();
    assert.equal(traffic, 1, 'idle polling remains bounded');
    owner._trafficSyncFeedbackState.busy = true;
    now = 700;
    tick();
    assert.equal(traffic, 2, 'busy completion is observed on a 100 ms tick');
    assert.equal(global, 1, 'other loading feedback keeps its prior budget');
    owner._trafficSyncFeedbackState.busy = false;
    now = 800;
    tick();
    assert.equal(traffic, 2);
    document.hidden = true;
    now = 1300;
    tick();
    assert.equal(traffic, 2, 'hidden pages do no polling');
    owner.destroy();
    assert.equal(f.timers.size, 0);
  } finally {
    f.restore();
  }
});

test('CCTV access shortcut opens the panel under collapsed-sibling rail layout without toggling', () => {
  const f = fixture();
  try {
    const stack = f.nodes.get('right-context-rail');
    stack.children = [];
    stack.contains = (child) => stack.children.includes(child);
    stack.classList.add('layout-focus', 'layout-exclusive');

    const displayPanel = f.nodes.get('pp-toggles');
    displayPanel.id = 'pp-toggles';
    displayPanel.parentElement = stack;
    stack.children.push(displayPanel);

    const cctvPanel = f.element();
    cctvPanel.id = 'cctv-panel';
    cctvPanel.parentElement = stack;
    cctvPanel.classList.add('collapsed');
    const attributes = new Map([['aria-hidden', 'true']]);
    cctvPanel.getAttribute = (name) => attributes.get(name) ?? null;
    cctvPanel.setAttribute = (name, value) => attributes.set(name, value);
    cctvPanel.removeAttribute = (name) => attributes.delete(name);
    let scrolled = 0;
    cctvPanel.scrollIntoView = () => {
      scrolled++;
    };

    let focused = 0;
    const hiddenAtFocus = [];
    const disclosureBtn = f.element();
    disclosureBtn.dataset = { collapseTarget: 'cctv-panel' };
    cctvPanel.contains = (target) =>
      target === disclosureBtn || target === innerControl;
    disclosureBtn.focus = () => {
      focused++;
      hiddenAtFocus.push(cctvPanel.getAttribute('aria-hidden'));
      document.activeElement = disclosureBtn;
    };
    disclosureBtn.blur = () => {
      if (document.activeElement === disclosureBtn)
        document.activeElement = document.body;
    };
    const innerControl = f.element();
    innerControl.focus = () => {
      document.activeElement = innerControl;
    };
    cctvPanel.querySelector = (selector) => {
      if (
        typeof selector === 'string' &&
        selector.includes('data-collapse-target="cctv-panel"')
      ) {
        return disclosureBtn;
      }
      return null;
    };
    stack.children.push(cctvPanel);

    const cctvGlobeBtn = f.element();
    cctvGlobeBtn.id = 'cctv-globe-btn';
    cctvGlobeBtn.focus = () => {
      document.activeElement = cctvGlobeBtn;
    };

    f.nodes.set('right-context-rail', stack);
    f.nodes.set('pp-toggles', displayPanel);
    f.nodes.set('cctv-panel', cctvPanel);
    f.nodes.set('cctv-globe-btn', cctvGlobeBtn);
    document.querySelectorAll = (selector) =>
      selector === '.panel-collapse-btn[data-collapse-target]'
        ? [disclosureBtn]
        : [];

    const claimed = [];
    const store = usePanelChromeStore(createPinia());
    followPanelState(store, 'cctv-panel', cctvPanel);
    const chrome = new PanelChrome({
      store,
      elements: {
        _leftPanelStack: f.nodes.get('left-panel-stack'),
        _rightPanelStack: stack,
        _ppToggles: displayPanel,
        _cctvGlobeBtn: cctvGlobeBtn,
      },
      operations: {
        _syncPanelCollapseButton() {},
        _layoutRightPanels() {},
        _syncCctvPanelViewport() {},
        _showToast() {},
      },
      readHud: () => ({ visible: true, getVariant: () => 'tactical' }),
      readCockpit: () => ({ active: false }),
      readShareLinks: () => ({
        claimRestoreLane(lane, id) {
          claimed.push([lane, id]);
        },
        onPanelStateChange() {},
      }),
      readInitialShare: () => null,
      readScrollRestoreOwner: () => 'standard',
      readDisplayScrollTop: () => 0,
    });

    chrome._initPanelChrome();
    chrome._initPanelChrome();

    // In the collapsed-sibling layout (layout-focus + layout-exclusive),
    // cctv-panel starts collapsed.
    assert.equal(cctvPanel.classList.contains('collapsed'), true);

    // Activating the globe shortcut opens CCTV via setPanelCollapsed('cctv-panel', false, { explicit: true })
    cctvGlobeBtn.dispatchEvent(new Event('click'));

    assert.equal(cctvPanel.classList.contains('collapsed'), false);
    assert.deepEqual(claimed, [['panel', 'cctv-panel']]);
    assert.equal(chrome._panelLayout._rightStackPreferredPanelId, 'cctv-panel');
    assert.equal(scrolled, 1);
    assert.equal(focused, 1);
    assert.deepEqual(
      hiddenAtFocus,
      [null],
      'focus must reach an accessible panel',
    );

    // If the panel is ALREADY open, activation brings into view or focuses disclosure rather than collapsing it
    cctvGlobeBtn.dispatchEvent(new Event('click'));
    assert.equal(
      cctvPanel.classList.contains('collapsed'),
      false,
      'must not toggle or collapse an open panel',
    );
    assert.equal(scrolled, 2);
    assert.equal(focused, 2);
    store.act('toggle', 'cctv-panel');
    assert.equal(cctvPanel.classList.contains('collapsed'), true);
    assert.equal(
      document.activeElement,
      cctvGlobeBtn,
      'manual collapse returns focus to the visible shortcut',
    );
    cctvGlobeBtn.dispatchEvent(new Event('click'));
    assert.equal(document.activeElement, disclosureBtn);
    const escape = new Event('keydown');
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    disclosureBtn.dispatchEvent(escape);
    assert.equal(chrome._collapsePanelOnEscape(escape, 'cctv-panel'), true);
    assert.equal(cctvPanel.classList.contains('collapsed'), true);
    assert.equal(document.activeElement, cctvGlobeBtn);
    cctvGlobeBtn.dispatchEvent(new Event('click'));
    innerControl.focus();
    const innerEscape = new Event('keydown');
    Object.defineProperty(innerEscape, 'key', { value: 'Escape' });
    innerControl.dispatchEvent(innerEscape);
    assert.equal(
      chrome._collapsePanelOnEscape(innerEscape, 'cctv-panel'),
      true,
    );
    assert.equal(cctvPanel.classList.contains('collapsed'), true);
    assert.equal(
      document.activeElement,
      cctvGlobeBtn,
      'Escape from panel content must not refocus a hidden disclosure',
    );
    chrome.setPanelCollapsed('cctv-panel', false, { explicit: true });
    innerControl.focus();
    const restoredEscape = new Event('keydown');
    Object.defineProperty(restoredEscape, 'key', { value: 'Escape' });
    innerControl.dispatchEvent(restoredEscape);
    assert.equal(
      chrome._collapsePanelOnEscape(restoredEscape, 'cctv-panel'),
      true,
    );
    assert.equal(
      document.activeElement,
      cctvGlobeBtn,
      'restored CCTV must not leave focus in an exclusive hidden header',
    );
    chrome.setPanelCollapsed('cctv-panel', false, { explicit: true });
    innerControl.focus();
    chrome.setPanelCollapsed('cctv-panel', true, { explicit: true });
    assert.equal(
      document.activeElement,
      cctvGlobeBtn,
      'manual collapse from a restored panel also returns visible focus',
    );

    // Disposal removes the listener
    chrome.destroy();
    cctvGlobeBtn.dispatchEvent(new Event('click'));
    assert.equal(scrolled, 4);
    assert.equal(focused, 6);
  } finally {
    f.restore();
  }
});
