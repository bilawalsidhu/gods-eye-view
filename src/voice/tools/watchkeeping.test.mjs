import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandlers, schemas, resetEnginesForTest } from './watchkeeping.js';
import { createHandlers as createPrediction } from './prediction.js';
import { createPositionHistory } from '../../history/positionHistory.js';

function fakeGlobe(records = {}) {
  const listeners = new Set();
  return {
    toasts: [],
    dataManager: {
      isEnabled: (id) => id in records,
      layers: { get: (id) => (id in records ? { module: { getAnalystRecords: () => records[id] } } : undefined) },
      subscribeActivity: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
      publish: (layerId) => { for (const cb of listeners) cb({ type: 'data-updated', layerId }); },
    },
    styleManager: { _showToast(t) { this.toasts.push(t); }, toasts: [] },
  };
}
function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
}

test('watchkeeping tools drive patrols, anomalies and geofences through one context', async (t) => {
  t.after(resetEnginesForTest);
  globalThis.localStorage = storage();
  const globe = fakeGlobe({ flights: [{ id: 'a1', callsign: 'UAL1', lat: 30.05, lon: -90, altitudeM: 9000 }] });
  const spoken = [];
  const annotations = [];
  const handlers = createHandlers({
    getGlobe: () => globe,
    camera: () => ({ lat: 30, lon: -90, alt: 100_000 }),
    speak: (text) => spoken.push(text),
    runner: async (name, args) => { annotations.push([name, args]); return { ok: true }; },
  });
  for (const s of schemas) assert.equal(typeof handlers[s.name], 'function', s.name);
  const patrol = await handlers.patrol_start({ name: 'test patrol', layers: ['flights'], scope: { kind: 'radius', km: 100 }, intervalMinutes: 5 });
  assert.equal(patrol.ok, true);
  assert.match(patrol.patrol.firstBriefing, /1 aircraft in range on the first pass/);
  assert.equal(spoken.length, 1);
  assert.equal((await handlers.patrol_list()).count, 1);
  const brief = await handlers.patrol_brief({ name: 'test' });
  assert.match(brief.briefing, /no change/);
  assert.equal((await handlers.patrol_stop({})).stopped, 1);

  const fence = await handlers.geofence_add({ name: 'box', shape: { kind: 'view' }, layers: ['flights'], alertOnEnter: true });
  assert.equal(fence.ok, true);
  assert.equal(fence.drawn, true);
  assert.equal(annotations[0][0], 'annotate_map');
  assert.equal(annotations[0][1].annotations[0].type, 'area');
  globe.dataManager.publish('flights');
  const report = await handlers.geofence_report({ name: 'box' });
  assert.equal(report.report.insideNow.flights.count, 1);
  assert.equal((await handlers.geofence_remove({})).removed, 1);

  const anomalies = await handlers.anomaly_list({});
  assert.equal(anomalies.ok, true);
  assert.equal((await handlers.anomaly_alerts({ enabled: false })).spokenAlerts, false);
  delete globalThis.localStorage;
});

test('prediction tools dead-reckon from history', async () => {
  const history = createPositionHistory({ dataManager: null, now: () => 1_000_000 });
  const t0 = 1_000_000;
  history.recordSnapshot('flights', [{ id: 'a1', callsign: 'UAL1', lat: 30, lon: -90, altitudeM: 9000, heading: 90, speedMps: 250 }], t0 - 60_000);
  history.recordSnapshot('flights', [{ id: 'a1', callsign: 'UAL1', lat: 30, lon: -89.9, altitudeM: 9000, heading: 90, speedMps: 250 }], t0);
  const calls = [];
  const handlers = createPrediction({
    getHistory: () => history,
    getTimeTravel: () => ({ forecast: (ms) => (calls.push(ms), true) }),
    camera: () => ({ lat: 30, lon: -89, alt: 1000 }),
  });
  const realNow = Date.now;
  Date.now = () => t0;
  try {
    const near = await handlers.who_will_be_near({ km: 80, minutes: 5, layer: 'flights' });
    assert.equal(near.count, 1, 'eastbound at 250 m/s covers ~75 km in 5 min');
    assert.ok(near.predicted[0].confidence > 0.4);
    const far = await handlers.who_will_be_near({ km: 5, minutes: 1 });
    assert.equal(far.count, 0);
    const shown = await handlers.predict_positions({ minutes: 5 });
    assert.equal(shown.ok, true);
    assert.deepEqual(calls, [5 * 60_000]);
  } finally {
    Date.now = realNow;
  }
});
