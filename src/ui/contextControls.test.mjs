import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextControls } from './contextControls.js';

function fixture(t, publish) {
  const calls = [];
  const controls = new ContextControls({
    publish,
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
    snapshotCaptured: false,
  });
});

test('a host can observe mode changes while the application omits the port', (t) => {
  const states = [];
  const { controls } = fixture(t, (state) => states.push(state));
  controls._syncContextModeButtons();
  assert.deepEqual(states, [
    { mode: 'none', enabled: false, flightsActive: false, busy: false },
  ]);
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

test('only a layer Context isolation is switching off is suspended', async (t) => {
  const { controls } = fixture(t);
  const enabled = new Set(['cctv']);
  // What the CCTV panel is told at each visibility change of its layer.
  const seen = [];
  controls._dataManager = {
    layers: new Map([['cctv', {}]]),
    getEnabledLayerIds: () => [...enabled],
    getLayerParams: () => null,
    setLayerParams() {},
    isEnabled: (layerId) => enabled.has(layerId),
    isEffectivelyEnabled: (layerId) => enabled.has(layerId),
    async setEnabled(layerId, next) {
      // The layer tells its panel it is off while it is being disabled.
      if (next) enabled.add(layerId);
      else enabled.delete(layerId);
      seen.push([layerId, next, controls.suspendsLayer(layerId)]);
      return true;
    },
    async restoreEnabledLayerIds(layerIds) {
      for (const layerId of layerIds) await this.setEnabled(layerId, true);
    },
  };
  assert.equal(controls.suspendsLayer('cctv'), false);
  controls._captureContextSessionSnapshot();
  await controls._clearLayersOutsideContextMode('flights');
  assert.deepEqual(seen, [['cctv', false, true]]);
  assert.equal(controls.suspendsLayer('cctv'), false, 'only while isolating');
  // Inside the mode the user turns CCTV back on, then off: their own.
  await controls._dataManager.setEnabled('cctv', true);
  await controls._dataManager.setEnabled('cctv', false);
  assert.deepEqual(seen.at(-1), ['cctv', false, false]);
  await controls._restoreContextSession();
  assert.equal(enabled.has('cctv'), true);
  // A switch-off after the mode is left is the user's own too.
  await controls._dataManager.setEnabled('cctv', false);
  assert.deepEqual(seen.at(-1), ['cctv', false, false]);
});

test('a failed isolation leaves no layer suspended', async (t) => {
  const { controls } = fixture(t);
  controls._dataManager = {
    layers: new Map([['cctv', {}]]),
    isEffectivelyEnabled: () => true,
    isEnabled: () => true,
    setEnabled: async () => {
      throw new Error('disable failed');
    },
  };
  await assert.rejects(controls._clearLayersOutsideContextMode('flights'));
  assert.equal(controls.suspendsLayer('cctv'), false);
});
