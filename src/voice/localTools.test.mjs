import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalTools, dataReport } from './localTools.js';
import { createLocalMemory } from './localMemory.js';
import { createWatchEngine } from './watchEngine.js';
import { LOCAL_TOOL_NAMES } from './localToolSchemas.js';

function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
}

function globe(records = {}, camera = { lat: 30, lon: -97, alt: 50_000, heading: 0, pitch: -45, roll: 0 }) {
  const flights = [];
  const enabled = new Set(Object.keys(records));
  return {
    flights,
    dataManager: {
      isEnabled: (id) => enabled.has(id),
      layers: { get: (id) => (enabled.has(id) ? { module: { getAnalystRecords: () => records[id] } } : undefined) },
      subscribeActivity: () => () => {},
    },
    styleManager: {
      getCameraState: () => camera,
      applyCameraState: (state, duration) => flights.push({ state, duration }),
    },
  };
}

test('every schema name has a handler', () => {
  const tools = createLocalTools({ memory: createLocalMemory({ storage: storage() }), watches: createWatchEngine({ storage: storage() }) });
  for (const name of LOCAL_TOOL_NAMES) assert.equal(tools.has(name), true, name);
  assert.equal(tools.has('fly_to_location'), false);
});

test('saved places round-trip through the tools and recall records results', async () => {
  const g = globe();
  const memory = createLocalMemory({ storage: storage(), now: () => 5 });
  const tools = createLocalTools({ memory, watches: createWatchEngine({ storage: storage() }), getGlobe: () => g });
  assert.deepEqual(await tools.run('remember_place', { name: 'home' }), { ok: true, saved: 'home', altitudeM: 50000 });
  assert.equal((await tools.run('list_saved_places')).places[0], 'home');
  const flight = await tools.run('go_to_saved_place', { name: 'take me home' });
  assert.equal(flight.ok, true);
  assert.equal(g.flights[0].state.lat, 30);
  const miss = await tools.run('go_to_saved_place', { name: 'marina' });
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.savedPlaces, ['home']);
  tools.noteActionResult('track_entity', { query: 'UAL1' }, { ok: true, id: 'abc', label: 'UAL1', kind: 'aircraft' });
  tools.noteActionResult('fly_to_location', { query: 'Paris' }, { ok: true, label: 'Paris' });
  tools.noteActionResult('fly_to_location', {}, { ok: false });
  const recall = await tools.run('recall_recent_target', { kind: 'aircraft' });
  assert.equal(recall.targets[0].id, 'abc');
  assert.equal((await tools.run('recall_recent_target', { query: 'par' })).targets[0].label, 'Paris');
  assert.equal((await tools.run('forget_place', { name: 'home' })).ok, true);
});

test('data_report groups, aggregates and scopes', async () => {
  const g = globe({
    flights: [
      { id: '1', callsign: 'UAL1', operator: 'United', lat: 30.1, lon: -97, altitudeM: 10000 },
      { id: '2', callsign: 'UAL2', operator: 'United', lat: 30.2, lon: -97, altitudeM: 8000 },
      { id: '3', callsign: 'DAL1', operator: 'Delta', lat: 30.3, lon: -97, altitudeM: 6000 },
      { id: '4', callsign: 'FAR', operator: 'Far', lat: 45, lon: 10, altitudeM: 1000 },
    ],
  });
  const report = await dataReport(
    { layer: 'flights', scope: { kind: 'view' }, groupBy: 'operator' },
    { getGlobe: () => g, camera: () => g.styleManager.getCameraState() },
  );
  assert.equal(report.ok, true);
  assert.equal(report.matched, 3, 'the far one is out of view');
  assert.deepEqual(report.groups.map((x) => [x.key, x.count]), [['United', 2], ['Delta', 1]]);
  const avg = await dataReport(
    { layer: 'flights', scope: { kind: 'anywhere' }, metric: 'avg', field: 'altitudeM', filters: [{ field: 'operator', op: 'eq', value: 'United' }] },
    { getGlobe: () => g, camera: () => null },
  );
  assert.deepEqual(avg.metric, { avg: 9000, field: 'altitudeM', samples: 2 });
  const off = await dataReport({ layer: 'earthquakes', scope: { kind: 'anywhere' } }, { getGlobe: () => g, camera: () => null });
  assert.match(off.error, /is off/);
  const cells = await dataReport({ layer: 'flights', scope: { kind: 'anywhere' }, groupBy: 'cell' }, { getGlobe: () => g, camera: () => null });
  assert.equal(cells.groups[0].key, '30N 97W');
});

test('watch and time-travel tools report clearly when unavailable', async () => {
  const g = globe({ flights: [] });
  const tools = createLocalTools({
    memory: createLocalMemory({ storage: storage() }),
    watches: createWatchEngine({ dataManager: g.dataManager, storage: storage(), getCamera: () => g.styleManager.getCameraState() }),
    getGlobe: () => g,
    getTimeTravel: () => null,
  });
  const added = await tools.run('watch_add', { layer: 'flights', description: 'planes near home', scope: { kind: 'radius', km: 30 } });
  assert.equal(added.ok, true);
  assert.equal(added.watch.radiusKm, 30);
  assert.equal((await tools.run('watch_list')).count, 1);
  assert.equal((await tools.run('watch_clear')).removed, 1);
  const rewind = await tools.run('rewind_time', { minutes: 10 });
  assert.equal(rewind.ok, false);
  assert.match(rewind.error, /not available/);
  const travel = { calls: [], range: () => ({ oldestT: Date.now() - 20 * 60000 }), rewind: (o) => travel.calls.push(['rewind', o]), setRate: (r) => travel.calls.push(['rate', r]), resumeLive: () => travel.calls.push(['live']) };
  const tools2 = createLocalTools({ memory: createLocalMemory({ storage: storage() }), watches: createWatchEngine({ storage: storage() }), getGlobe: () => g, getTimeTravel: () => travel });
  const ok = await tools2.run('rewind_time', { minutes: 10, rate: 4 });
  assert.equal(ok.rewoundMinutes, 10);
  assert.deepEqual(travel.calls, [['rewind', -600000], ['rate', 4]]);
  await tools2.run('resume_live');
  assert.deepEqual(travel.calls.at(-1), ['live']);
});
