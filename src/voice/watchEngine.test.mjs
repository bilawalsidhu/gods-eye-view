import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWatchEngine,
  matchesFilter,
  resolveScope,
  inScope,
  WATCH_STORAGE_KEY,
} from './watchEngine.js';

function fakeDataManager(records = {}) {
  const listeners = new Set();
  const enabled = new Set(Object.keys(records));
  return {
    records,
    isEnabled: (id) => enabled.has(id),
    layers: {
      get: (id) =>
        enabled.has(id)
          ? { module: { getAnalystRecords: () => records[id] } }
          : undefined,
    },
    subscribeActivity(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    publish(layerId) {
      for (const cb of listeners) cb({ type: 'data-updated', layerId });
    },
  };
}

function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), map };
}

test('filters and scopes behave', () => {
  assert.equal(matchesFilter({ speedKts: 5 }, { field: 'speedKts', op: 'lt', value: 8 }), true);
  assert.equal(matchesFilter({ operator: 'United' }, { field: 'operator', op: 'contains', value: 'unit' }), true);
  assert.equal(matchesFilter({}, { field: 'x', op: 'eq', value: 1 }), false);
  const camera = { lat: 30, lon: -97, alt: 100_000 };
  assert.deepEqual(resolveScope({ kind: 'view' }, camera), { lat: 30, lon: -97, km: 160 });
  assert.equal(resolveScope({ kind: 'anywhere' }, camera), null);
  assert.deepEqual(resolveScope({ kind: 'radius', km: 20 }, camera), { lat: 30, lon: -97, km: 20 });
  assert.equal(inScope({ lat: 30.1, lon: -97 }, { lat: 30, lon: -97, km: 20 }), true);
  assert.equal(inScope({ lat: 31, lon: -97 }, { lat: 30, lon: -97, km: 20 }), false);
});

test('a watch alerts once per new matching record, baselines existing ones, and persists', async () => {
  const dm = fakeDataManager({
    flights: [
      { id: 'a1', callsign: 'UAL1', lat: 30.05, lon: -97, altitudeM: 9000, operator: 'United' },
    ],
  });
  const store = storage();
  const alerts = [];
  let clock = 0;
  const engine = createWatchEngine({
    dataManager: dm,
    getCamera: () => ({ lat: 30, lon: -97, alt: 5000 }),
    onAlert: (a) => alerts.push(a.text),
    storage: store,
    now: () => (clock += 5000),
  });
  const created = engine.add({
    layer: 'flights',
    description: 'plane near home',
    scope: { kind: 'radius', km: 20 },
    filters: [{ field: 'altitudeM', op: 'lt', value: 12000 }],
  });
  assert.equal(created.baseline, 1, 'existing match is baseline, not news');
  assert.equal(alerts.length, 0);
  dm.records.flights.push({ id: 'b2', callsign: 'DAL2', lat: 30.1, lon: -97.05, altitudeM: 3000, operator: 'Delta' });
  dm.publish('flights');
  assert.deepEqual(alerts, ['plane near home: DAL2, 3000 m, Delta.']);
  dm.publish('flights');
  assert.equal(alerts.length, 1, 'no repeat for the same record');
  dm.records.flights.push({ id: 'c3', callsign: 'FAR3', lat: 35, lon: -97, altitudeM: 3000 });
  dm.publish('flights');
  assert.equal(alerts.length, 1, 'outside the radius');
  assert.equal(engine.list().length, 1);
  assert.ok(store.map.get(WATCH_STORAGE_KEY).includes('plane near home'));
  const reloaded = createWatchEngine({ dataManager: dm, storage: store, onAlert: () => {} });
  assert.equal(reloaded.list()[0].seen, 2);
  assert.equal(engine.clear(), 1);
  assert.equal(engine.list().length, 0);
});

test('once-watches remove themselves and unknown layers are refused', () => {
  const dm = fakeDataManager({ earthquakes: [] });
  const alerts = [];
  const engine = createWatchEngine({ dataManager: dm, onAlert: (a) => alerts.push(a), storage: storage(), now: () => 1 });
  engine.add({ layer: 'earthquakes', description: 'big quake', scope: { kind: 'anywhere' }, filters: [{ field: 'mag', op: 'gte', value: 5 }], once: true });
  dm.records.earthquakes.push({ id: 'q1', mag: 5.4, place: 'near Tokyo', lat: 35, lon: 139, depth: 10 });
  dm.publish('earthquakes');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /big quake: M5\.4 near Tokyo, 10 km deep\./);
  assert.equal(engine.list().length, 0, 'once watch removed');
  assert.throws(() => engine.add({ layer: 'cctv', description: 'x', scope: { kind: 'anywhere' } }), /Cannot watch/);
  engine.destroy();
});
