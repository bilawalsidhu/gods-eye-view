import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextControls } from './contextControls.js';

class Button extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map();
  }
  getAttribute(name) {
    return this.attributes.get(name);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, elements = {}) {
  const calls = [];
  const controls = new ContextControls({
    elements,
    installations: {},
    actions: {
      getCockpit: () => null,
      claimVisualAuthority: () => calls.push('claim'),
      showToast: () => calls.push('notice'),
      setClearBusy: () => {},
      syncDetection: () => {},
      scheduleLayout: () => {},
      refreshRadio: () => {},
      setPanelCollapsed: () => calls.push('expand'),
    },
  });
  t.after(() => {
    controls.stop();
    controls.disconnect();
  });
  return { controls, calls };
}

test('Context starts with an explicit idle snapshot', (t) => {
  const { controls } = fixture(t);
  assert.deepEqual(controls.getContextModeState(), {
    mode: null,
    active: false,
    changing: false,
    entering: null,
    canContact: true,
    canMission: true,
    snapshotCaptured: false,
  });
});

test('a pending Context tab cannot reopen a disposed panel', async (t) => {
  const tab = new Button();
  const { controls, calls } = fixture(t, { _globalContextFlightsBtn: tab });
  let release;
  controls._selectContextMode = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  tab.dispatchEvent(new Event('click'));
  assert.deepEqual(calls, ['claim']);
  controls.stop();
  release(true);
  await turn();
  tab.dispatchEvent(new Event('click'));
  assert.deepEqual(calls, ['claim']);
});

test('stopping during installations enable prevents the delayed search', async (t) => {
  const button = new Button();
  const { controls, calls } = fixture(t, { _installationsSearchBtn: button });
  let release;
  controls._dataManager = {
    layers: new Map([['military-installations', {}]]),
    setEnabled: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    isEnabled: () => true,
  };
  controls.installations.searchNearby = () =>
    assert.fail('search started after stop');
  button.dispatchEvent(new Event('click'));
  controls.stop();
  release(true);
  await turn();
  assert.equal(calls.length, 0);
  assert.equal(
    button.getAttribute('aria-busy'),
    'true',
    'disposed controls are not mutated by completion',
  );
});

test('a late installations search cannot publish a notice after disposal', async (t) => {
  const button = new Button();
  const { controls, calls } = fixture(t, { _installationsSearchBtn: button });
  let release;
  controls._dataManager = {
    layers: new Map([['military-installations', {}]]),
    setEnabled: async () => true,
    isEnabled: () => true,
  };
  controls.installations.searchNearby = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  button.dispatchEvent(new Event('click'));
  await turn();
  controls.stop();
  release(true);
  await turn();
  assert.deepEqual(calls, []);
});

test('reconnecting and disposal release each manager subscription exactly once', (t) => {
  const { controls } = fixture(t);
  const counts = new Map();
  const manager = (name) =>
    Object.fromEntries(
      [
        'subscribe',
        'subscribeVisibilityRequests',
        'addVisibilityGuard',
        'subscribeBeforeDestroy',
      ].map((method) => [
        method,
        () => () => {
          const key = `${name}:${method}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        },
      ]),
    );
  controls.connect(manager('a'));
  controls.connect(manager('b'));
  assert.equal(counts.size, 4);
  controls.stop();
  controls.disconnect();
  controls.disconnect();
  controls.connect(manager('c'));
  assert.equal(counts.size, 8);
  assert.ok([...counts.values()].every((count) => count === 1));
});

test('a rejected tracked reaction settles without an unhandled rejection', async (t) => {
  const { controls } = fixture(t);
  const failure = new Error('source unavailable');
  const pending = controls._trackContextLayerReaction(Promise.reject(failure));
  await assert.rejects(pending, failure);
  await controls._waitForContextLayerSettlement();
  assert.equal(controls._contextLayerReactionPromises.size, 0);
});
