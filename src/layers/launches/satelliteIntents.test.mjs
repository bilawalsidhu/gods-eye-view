// An explicit Satellites action while Space Missions is on or starting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSatelliteIntents } from './satelliteIntents.js';

/** A manager whose effective and settled state can differ. */
function rig({ effective, snapshot = { enabled: false } } = {}) {
  const calls = [];
  const listeners = { requests: new Set(), changes: new Set() };
  const manager = {
    isEffectivelyEnabled: (id) => Boolean(effective[id]),
    async setEnabled(id, enabled, options) {
      calls.push([id, enabled, options?.origin]);
      return true;
    },
    subscribeVisibilityRequests(listener) {
      listeners.requests.add(listener);
      return () => listeners.requests.delete(listener);
    },
    subscribe(listener) {
      listeners.changes.add(listener);
      return () => listeners.changes.delete(listener);
    },
  };
  const state = {
    _dataManager: manager,
    _satelliteStateBeforeMission: snapshot,
  };
  const intents = createSatelliteIntents({ state });
  intents.connect(manager);
  const request = (layerId, enabled, intentEpoch) => {
    for (const listener of listeners.requests)
      listener({
        type: 'visibility-requested',
        layerId,
        enabled,
        intentEpoch,
      });
  };
  const settle = (change) => {
    for (const listener of listeners.changes) listener(change);
  };
  return { calls, intents, listeners, manager, state, request, settle };
}

const satellitesOff = {
  type: 'visibility',
  layerId: 'satellites',
  enabled: false,
  origin: 'user',
  intentEpoch: 7,
};

test('a Satellites OFF asked for after the mission start ends Space Missions', async () => {
  const r = rig({ effective: { satellites: false, 'rocket-launches': true } });
  r.request('rocket-launches', true, 3);
  r.request('satellites', false, 7);
  r.settle(satellitesOff);
  assert.equal(await r.intents.settled(), true);
  assert.deepEqual(r.calls, [['rocket-launches', false, 'user']]);
  assert.equal(
    r.state._satelliteStateBeforeMission.restoreVisibility,
    false,
    'the teardown leaves Satellites as the person set it',
  );
});

test('a Satellites OFF asked for before the mission start leaves the start alone', () => {
  const r = rig({ effective: { satellites: false, 'rocket-launches': true } });
  r.request('satellites', false, 7);
  r.request('rocket-launches', true, 3);
  r.settle(satellitesOff);
  assert.deepEqual(r.calls, []);
  assert.equal(r.state._satelliteStateBeforeMission.restoreVisibility, false);
});

test('a Satellites OFF without request records is treated as the newer action', async () => {
  const r = rig({ effective: { satellites: false, 'rocket-launches': true } });
  assert.equal(await r.intents.handleVisibility(satellitesOff), true);
  assert.deepEqual(r.calls, [['rocket-launches', false, 'user']]);
});

test('a superseded Satellites event is left to the newer request', () => {
  // A newer Satellites ON is queued, but this OFF has already settled.
  const r = rig({ effective: { satellites: true, 'rocket-launches': true } });
  assert.equal(r.intents.handleVisibility(satellitesOff), false);
  assert.deepEqual(r.calls, []);
  assert.equal(
    r.state._satelliteStateBeforeMission.restoreVisibility,
    undefined,
  );
});

test('a Satellites ON while the missions are on is kept through their exit', () => {
  const r = rig({ effective: { satellites: true, 'rocket-launches': true } });
  assert.equal(
    r.intents.handleVisibility({ ...satellitesOff, enabled: true }),
    false,
  );
  assert.deepEqual(r.calls, []);
  assert.equal(r.state._satelliteStateBeforeMission.restoreVisibility, false);
});

test('only direct user and voice Satellites actions count', () => {
  // Settled: a scene, story, preset or other programmatic Satellites OFF
  // neither ends Space Missions nor survives its teardown.
  for (const origin of [
    'programmatic',
    'context-restore',
    'dependency',
    'scene',
    'tool',
  ]) {
    const r = rig({
      effective: { satellites: false, 'rocket-launches': true },
    });
    assert.equal(
      r.intents.handleVisibility({ ...satellitesOff, origin }),
      false,
    );
    assert.deepEqual(r.calls, []);
    assert.equal(
      r.state._satelliteStateBeforeMission.restoreVisibility,
      undefined,
    );
  }
  const voice = rig({
    effective: { satellites: false, 'rocket-launches': true },
  });
  voice.settle({ ...satellitesOff, origin: 'voice' });
  assert.deepEqual(voice.calls, [['rocket-launches', false, 'voice']]);
});

test('with Space Missions off, a Satellites action is not its business', () => {
  const r = rig({ effective: { satellites: false }, snapshot: null });
  assert.equal(r.intents.handleVisibility(satellitesOff), false);
  assert.deepEqual(r.calls, []);
});

test('reconnecting and detaching release each manager subscription', () => {
  const r = rig({ effective: {} });
  assert.equal(r.listeners.requests.size, 1);
  assert.equal(r.listeners.changes.size, 1);
  r.intents.connect(r.manager);
  assert.equal(r.listeners.requests.size, 1, 'no duplicate subscription');
  assert.equal(r.listeners.changes.size, 1);
  r.intents.connect(null);
  assert.equal(r.listeners.requests.size, 0);
  assert.equal(r.listeners.changes.size, 0);
});

test('a failed stop is reported, not thrown', async () => {
  const r = rig({ effective: { satellites: false, 'rocket-launches': true } });
  r.manager.setEnabled = async () => {
    throw new Error('injected stop failure');
  };
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(await r.intents.handleVisibility(satellitesOff), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.equal(await r.intents.settled(), false, 'nothing left pending');
});
