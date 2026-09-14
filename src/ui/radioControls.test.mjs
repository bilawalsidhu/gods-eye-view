import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RadioControls } from './radioControls.js';

class Element extends EventTarget {
  constructor() {
    super();
    this.attrs = new Map();
    this.classes = new Set();
    this.focusCount = 0;
    this.isConnected = true;
    this.classList = {
      add: (...names) => names.forEach((n) => this.classes.add(n)),
      remove: (...names) => names.forEach((n) => this.classes.delete(n)),
      contains: (name) => this.classes.has(name),
      toggle: (name, enabled) =>
        enabled ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this.attrs.get(name);
  }
  querySelector() {
    return null;
  }
  focus() {
    this.focusCount++;
  }
}

function fixture() {
  const prior = { document: globalThis.document, window: globalThis.window };
  const document = new EventTarget();
  document.getElementById = () => null;
  globalThis.document = document;
  globalThis.window = new EventTarget();
  const panel = new Element();
  const enable = new Element();
  const next = new Element();
  const calls = [];
  const subscribers = [];
  const radio = {
    subscribe(callback) {
      subscribers.push(callback);
      calls.push('subscribe');
      return () => calls.push('unsubscribe');
    },
    endTuning() {
      calls.push('endTuning');
    },
    cycleStation(direction) {
      calls.push(['cycle', direction]);
      return true;
    },
  };
  const actions = {
    isRegistered: () => true,
    isEnabled: () => false,
    runUserAction: (operation) => operation(),
    setEnabled: async () => true,
    setPanelCollapsed: (...args) => calls.push(['panel', ...args]),
    layoutCockpit() {},
    isCockpitActive: () => false,
    scheduleLayout() {},
    getLifecycle: () => null,
    preservePanelStateDuringClear: () => false,
  };
  const controls = new RadioControls({
    elements: {
      _radioPanel: panel,
      _radioEnableBtn: enable,
      _radioNextBtn: next,
    },
    radio,
    actions,
    canvas: new Element(),
  });
  return {
    controls,
    enable,
    next,
    actions,
    calls,
    subscribers,
    document,
    cleanup() {
      controls.destroy();
      Object.assign(globalThis, prior);
    },
  };
}

test('Radio listeners and subscriptions are revoked once before tuning teardown', () => {
  const f = fixture();
  try {
    f.controls.connect();
    f.next.dispatchEvent(new Event('click'));
    assert.deepEqual(f.calls, ['subscribe', ['cycle', 1]]);
    f.controls.destroy();
    f.controls.destroy();
    const snapshot = structuredClone(f.calls);
    f.controls._setRadioDisclosure(true);
    f.controls._setCockpitDisclosure('display', true);
    f.next.dispatchEvent(new Event('click'));
    f.document.dispatchEvent(new Event('gev:radio-selected'));
    f.subscribers[0]({ enabled: true });
    f.controls.connect();
    assert.deepEqual(f.calls, snapshot);
    assert.deepEqual(f.calls.slice(-2), ['unsubscribe', 'endTuning']);
  } finally {
    f.cleanup();
  }
});

test('Radio reconnect removes its previous state subscription', () => {
  const f = fixture();
  try {
    f.controls.connect();
    f.controls.connect();
    assert.deepEqual(f.calls, ['subscribe', 'unsubscribe', 'subscribe']);
  } finally {
    f.cleanup();
  }
});

test('a delayed Radio enable cannot reveal or refocus controls after destruction', async () => {
  const f = fixture();
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  try {
    f.actions.setEnabled = () => pending;
    f.enable.dispatchEvent(new Event('click'));
    assert.equal(f.enable.getAttribute('aria-busy'), 'true');
    f.controls.destroy();
    const attrs = new Map(f.enable.attrs);
    resolve(true);
    await pending;
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(f.enable.attrs, attrs);
    assert.equal(f.enable.focusCount, 0);
    assert.equal(
      f.calls.some((call) => Array.isArray(call) && call[0] === 'panel'),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('destruction releases an active tuner pointer after revoking listeners', () => {
  const f = fixture();
  try {
    const released = [];
    f.controls._radioTunerSlider = {
      releasePointerCapture(id) {
        assert.equal(f.controls.listeners.signal.aborted, true);
        released.push(id);
      },
    };
    f.controls._radioTunerPointerId = 7;
    f.controls._radioTunerDragging = true;
    f.controls.destroy();
    assert.deepEqual(released, [7]);
    assert.equal(f.controls._radioTunerDragging, false);
    assert.equal(f.controls._radioTunerPointerId, null);
  } finally {
    f.cleanup();
  }
});
