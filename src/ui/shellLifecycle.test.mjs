import test from 'node:test';
import assert from 'node:assert/strict';
import { UiLifetime } from './uiLifetime.js';
import { PanelLayoutController } from './panelLayoutController.js';
import { PanelPositionControls } from './panelPositionControls.js';
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
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
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
      'toast',
      'global-loading-status',
      'global-loading-detail',
      'safe-frame-overlay',
      'safe-frame-box',
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
      syncPanelCollapseButton() {},
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

test('panel disposal cancels a live drag without saving or accepting later pointer movement', () => {
  const f = fixture();
  try {
    const owner = new PanelPositionControls({
      syncPanelCollapseButton() {},
      layoutRightPanels() {},
      syncCctvPanelViewport() {},
      showToast() {},
    });
    const panel = f.element(),
      handle = f.element();
    owner._makePanelDraggable('sample', panel, handle);
    handle.dispatchEvent(
      Object.assign(new Event('pointerdown', { cancelable: true }), {
        button: 0,
        clientX: 30,
        clientY: 40,
      }),
    );
    assert.equal(panel.classList.contains('panel-dragging'), true);
    owner.destroy();
    const before = { ...panel.style };
    window.dispatchEvent(
      Object.assign(new Event('pointermove'), { clientX: 500, clientY: 300 }),
    );
    window.dispatchEvent(new Event('pointerup'));
    assert.deepEqual(panel.style, before);
    assert.equal(panel.classList.contains('panel-dragging'), false);
    owner._makePanelDraggable('sample', panel, handle);
    owner._initPanelDrag();
    owner._ppToggles.style.top = '10000px';
    owner._reclampDraggablePanels();
    assert.equal(owner._ppToggles.style.top, '10000px');
    assert.equal(owner.removers.length, 0);
    assert.deepEqual(f.writes, []);
  } finally {
    f.restore();
  }
});

test('feedback disposal clears toast and polling work and rejects retained notices', () => {
  const f = fixture();
  try {
    const owner = new ShellFeedback({ readLayers: () => [] });
    owner.observeVisibility();
    owner._startTrafficChipTicker();
    owner._showToast('Saved');
    assert.equal(f.timers.size, 2);
    owner.destroy();
    owner._showToast('Late');
    owner._showGlobalStatusNotice('Late');
    owner._startTrafficChipTicker();
    document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(f.timers.size, 0);
    assert.equal(f.nodes.get('toast').textContent, 'Saved');
    assert.equal(f.nodes.get('toast').classList.contains('visible'), false);
    assert.equal(f.nodes.get('global-loading-status').hidden, true);
  } finally {
    f.restore();
  }
});

test('recording restores the original HUD after repeated entry and revokes retained controls', () => {
  const f = fixture();
  try {
    let mode = 'auto',
      variant = 'tactical';
    const owner = new RecordingControls({ syncShareState() {} });
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
    assert.equal(document.body.classList.contains('recording-mode'), false);
    assert.equal(
      f.nodes.get('safe-frame-overlay').classList.contains('active'),
      false,
    );
  } finally {
    f.restore();
  }
});
